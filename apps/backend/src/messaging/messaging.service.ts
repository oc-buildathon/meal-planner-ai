import { Injectable, Inject, Logger, OnModuleInit } from "@nestjs/common";
import type { MessagingAdapter } from "./adapters/adapter.interface";
import type {
  IncomingMessage,
  OutgoingMessage,
  AdapterStatus,
  Platform,
} from "./messaging.types";
import { LlmService } from "../llm/llm.service";

/**
 * MessagingService — the unified messaging brain.
 *
 * Adapters (WhatsApp, Telegram) register themselves here.
 * Incoming messages from any platform are routed through a single handler.
 * Outgoing messages are dispatched to the correct adapter by platform/chatId.
 */
@Injectable()
export class MessagingService implements OnModuleInit {
  private readonly logger = new Logger(MessagingService.name);
  private adapters = new Map<Platform, MessagingAdapter>();

  constructor(@Inject(LlmService) private readonly llm: LlmService) {}

  async onModuleInit() {
    this.logger.log(
      `Messaging service initialized with ${this.adapters.size} adapter(s): [${[...this.adapters.keys()].join(", ")}]`,
    );
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
   * This is where the Agent Brain will plug in later (via deepagents).
   * For now: echo back with an LLM response.
   */
  private async handleIncomingMessage(message: IncomingMessage) {
    this.logger.log(
      `[${message.platform}] ${message.senderName} (${message.chatId}): ${message.type} — ${message.text?.slice(0, 100) ?? "(no text)"}`,
    );

    // Skip non-text messages for now (media handling comes in Phase 2)
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
      // Use the LLM to generate a response
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
      this.logger.error(`LLM error: ${error}`);
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
