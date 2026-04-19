import { Injectable, Inject, Logger, OnModuleInit } from "@nestjs/common";
import type { MessagingAdapter } from "./adapters/adapter.interface";
import type {
  IncomingMessage,
  OutgoingMessage,
  AdapterStatus,
  Platform,
} from "./messaging.types";
import { LlmService } from "../llm/llm.service";
import { UsersService } from "../database/users.service";
import { MessageLogService } from "../database/message-log.service";

/**
 * Callback signature for the deep agent orchestrator.
 * When set, all incoming messages are routed through the agent.
 * The processor is responsible for sending replies via MessagingService.sendMessage().
 */
export type MessageProcessor = (message: IncomingMessage) => Promise<void>;

/**
 * MessagingService — the unified messaging brain.
 *
 * Adapters (WhatsApp, Telegram) register themselves here.
 * Incoming messages from any platform are routed through a single handler.
 * Outgoing messages are dispatched to the correct adapter by platform/chatId.
 *
 * The OrchestratorService registers itself as the messageProcessor during init.
 * When set, messages go through the deep agent. Otherwise, falls back to raw LLM.
 */
@Injectable()
export class MessagingService implements OnModuleInit {
  private readonly logger = new Logger(MessagingService.name);
  private adapters = new Map<Platform, MessagingAdapter>();
  private messageProcessor: MessageProcessor | null = null;

  constructor(
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(MessageLogService) private readonly messageLog: MessageLogService,
  ) {}

  async onModuleInit() {
    this.logger.log(
      `Messaging service initialized with ${this.adapters.size} adapter(s): [${[...this.adapters.keys()].join(", ")}]`,
    );
  }

  /**
   * Called by OrchestratorService to register itself as the primary message handler.
   * When set, incoming messages are routed through the deep agent orchestrator
   * instead of the raw LLM fallback.
   */
  setMessageProcessor(processor: MessageProcessor) {
    this.messageProcessor = processor;
    this.logger.log("Deep agent orchestrator registered as message processor");
  }

  /**
   * Called by each adapter module during init to register itself.
   */
  registerAdapter(adapter: MessagingAdapter) {
    this.adapters.set(adapter.platform, adapter);
    adapter.onMessage((msg) => this.handleIncomingMessage(msg));
    this.logger.log(`Registered adapter: ${adapter.platform}`);
  }

  /**
   * Central handler for ALL incoming messages, regardless of platform.
   * Routes through the deep agent orchestrator if available,
   * otherwise falls back to direct LLM completion.
   */
  private async handleIncomingMessage(message: IncomingMessage) {
    this.logger.log(
      `[${message.platform}] ${message.senderName} (${message.chatId}): ${message.type} — ${message.text?.slice(0, 100) ?? "(no text)"}`,
    );

    // Log incoming message for audit/history
    if (message.dbUserId) {
      this.messageLog.log({
        userId: message.dbUserId,
        platform: message.platform,
        platformMsgId: message.id,
        direction: "in",
        type: message.type,
        text: message.text ?? null,
      });
    }

    // Route through deep agent orchestrator if registered
    if (this.messageProcessor) {
      try {
        await this.messageProcessor(message);
      } catch (error) {
        this.logger.error(`Agent processor error: ${error}`);
        await this.sendMessage(
          {
            chatId: message.chatId,
            type: "text",
            text: "Sorry, the agent encountered an error. Please try again.",
          },
          message.platform,
        );
      }
      return;
    }

    // --- Fallback: direct LLM (no agent registered) ---

    if (message.type !== "text" || !message.text) {
      await this.sendMessage(
        {
          chatId: message.chatId,
          type: "text",
          text: `Received your ${message.type}. Media processing coming soon!`,
        },
        message.platform,
      );
      return;
    }

    try {
      const reply = await this.llm.complete(
        message.text,
        `You are MealPrep, a helpful meal planning assistant. You help users plan meals, talk to their cook, and order groceries. Be concise and friendly. The user's name is ${message.senderName}. Respond in the same language as the user's message.`,
      );

      await this.sendMessage(
        {
          chatId: message.chatId,
          type: "text",
          text: reply,
          replyToMessageId: message.id,
        },
        message.platform,
      );
    } catch (error) {
      this.logger.error(`LLM fallback error: ${error}`);
      await this.sendMessage(
        {
          chatId: message.chatId,
          type: "text",
          text: "Sorry, I encountered an error processing your message. Please try again.",
        },
        message.platform,
      );
    }
  }

  /**
   * Send a message through a specific platform adapter.
   */
  async sendMessage(message: OutgoingMessage, platform: Platform) {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      this.logger.warn(`No adapter registered for platform: ${platform}`);
      return;
    }
    await adapter.sendMessage(message);

    // Log outgoing message — best-effort lookup by chatId
    try {
      const user = this.users.findByChatId(platform, message.chatId);
      if (user) {
        this.messageLog.log({
          userId: user.id,
          platform,
          direction: "out",
          type: message.type,
          text: message.text ?? message.caption ?? null,
        });
      }
    } catch (e) {
      this.logger.debug(`Outgoing log skipped: ${e}`);
    }
  }

  /**
   * Send a message to a user, auto-detecting their platform from the chatId format.
   * WhatsApp JIDs contain '@', Telegram chat IDs are numeric.
   */
  async sendAutoDetect(message: OutgoingMessage) {
    const platform = this.detectPlatform(message.chatId);
    await this.sendMessage(message, platform);
  }

  private detectPlatform(chatId: string): Platform {
    if (chatId.includes("@")) return "whatsapp";
    return "telegram";
  }

  /** Get status of all registered adapters (for /health endpoint). */
  getActiveAdapters(): AdapterStatus[] {
    return [...this.adapters.values()].map((a) => a.getStatus());
  }
}
