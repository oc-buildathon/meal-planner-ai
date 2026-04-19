import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
} from "@nestjs/common";
import {
  createDeepAgent,
  CompositeBackend,
  StateBackend,
  StoreBackend,
} from "deepagents";
import { Command } from "@langchain/langgraph";
import { LlmService } from "../llm/llm.service";
import { MessagingService } from "../messaging/messaging.service";
import type { IncomingMessage, Platform } from "../messaging/messaging.types";
import { AgentMemoryService } from "./memory/memory.service";

// Subagents
import {
  tasteLearnerSubagent,
  dietTrackerSubagent,
  socialPlannerSubagent,
  createChefCommSubagent,
  groceryExecutorSubagent,
} from "./subagents";

/** Pending interrupt state for a user's chat */
interface PendingInterrupt {
  threadId: string;
  interrupts: {
    actionRequests: Array<{ name: string; args: Record<string, unknown> }>;
    reviewConfigs?: Array<{ actionName: string; allowedDecisions: string[] }>;
  };
  platform: Platform;
}

/**
 * OrchestratorService — the main "meal-planner-engine" deep agent.
 *
 * Coordinates all subagents (taste-learner, diet-tracker, social-planner,
 * chef-comm, grocery-executor), manages per-user threads, and handles
 * human-in-the-loop interrupts via the chat interface.
 */
@Injectable()
export class OrchestratorService implements OnModuleInit {
  private readonly logger = new Logger(OrchestratorService.name);

  /** The compiled deep agent graph (typed as any — return type of createDeepAgent is complex) */
  private agent: any = null;

  /** Map chatId -> threadId for conversation continuity */
  private threadMap = new Map<string, string>();

  /** Map chatId -> pending interrupt awaiting user decision */
  private pendingInterrupts = new Map<string, PendingInterrupt>();

  constructor(
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(AgentMemoryService) private readonly memory: AgentMemoryService,
    @Inject(MessagingService) private readonly messaging: MessagingService,
  ) {}

  async onModuleInit() {
    try {
      await this.createAgent();
      // Register as the primary message processor on MessagingService
      this.messaging.setMessageProcessor((msg) => this.processMessage(msg));
      this.logger.log("Orchestrator agent created and registered as message processor");
    } catch (error) {
      this.logger.error(`Failed to create orchestrator agent: ${error}`);
      this.logger.warn("Falling back to direct LLM mode (no agent features)");
    }
  }

  // -------------------------------------------------------------------
  // Agent creation
  // -------------------------------------------------------------------

  private async createAgent() {
    const model = this.llm.getModel();
    const ns = AgentMemoryService.AGENT_NAMESPACE;

    // Chef-comm needs MessagingService for its tools
    const chefCommSubagent = createChefCommSubagent(this.messaging);

    this.agent = await createDeepAgent({
      model,
      name: "meal-planner-engine",
      systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,

      // Memory files loaded into context at startup
      memory: ["/memories/AGENT.md"],

      // Skills loaded on-demand via progressive disclosure
      skills: ["/skills/"],

      // Specialized subagents for delegated work
      subagents: [
        tasteLearnerSubagent,
        dietTrackerSubagent,
        socialPlannerSubagent,
        chefCommSubagent,
        groceryExecutorSubagent,
      ] as any[],

      // Human-in-the-loop: pause before sensitive operations
      interruptOn: {
        send_whatsapp_message: true,
        send_telegram_message: true,
        place_order: true,
        update_diet: { allowedDecisions: ["approve", "reject"] },
      },

      // Composite backend: StateBackend for scratch + StoreBackend for persistent paths
      backend: new CompositeBackend(
        new StateBackend(),
        {
          "/memories/": new StoreBackend({ namespace: ns }),
          "/taste/": new StoreBackend({ namespace: ns }),
          "/diet/": new StoreBackend({ namespace: ns }),
          "/chat-history/": new StoreBackend({ namespace: ns }),
          "/orders/": new StoreBackend({ namespace: ns }),
          "/social/": new StoreBackend({ namespace: ns }),
          "/skills/": new StoreBackend({ namespace: ns }),
        },
      ),

      store: this.memory.store,
      checkpointer: this.memory.checkpointer,
    });

    this.logger.log(
      "Deep agent created: 5 subagents, 3 skills, human-in-the-loop enabled",
    );
  }

  // -------------------------------------------------------------------
  // Message processing (called by MessagingService)
  // -------------------------------------------------------------------

  async processMessage(message: IncomingMessage): Promise<void> {
    if (!this.agent) {
      this.logger.warn("Agent not initialized — skipping message");
      return;
    }

    const chatId = message.chatId;

    // If there's a pending interrupt for this chat, handle the response
    if (this.pendingInterrupts.has(chatId)) {
      await this.handleInterruptResponse(message);
      return;
    }

    // Skip non-text for now (Phase 2: multimodal)
    if (message.type !== "text" || !message.text) {
      await this.messaging.sendMessage(
        {
          chatId,
          type: "text",
          text: `Got your ${message.type}. Media processing is coming in a future update — try sending a text message.`,
        },
        message.platform,
      );
      return;
    }

    // Prefix with sender name for context
    const content = message.senderName
      ? `[${message.senderName}]: ${message.text}`
      : message.text;

    const threadId = this.getOrCreateThread(chatId);
    const config = { configurable: { thread_id: threadId } };

    try {
      const result = await this.agent.invoke(
        { messages: [{ role: "user", content }] },
        { ...config, recursionLimit: 50 },
      );

      // Check if the agent paused for human approval
      if (result.__interrupt__) {
        await this.handleInterrupt(chatId, message.platform, result, threadId);
        return;
      }

      // Send the agent's reply
      const reply = this.extractReply(result);
      if (reply) {
        await this.messaging.sendMessage(
          { chatId, type: "text", text: reply, replyToMessageId: message.id },
          message.platform,
        );
      }
    } catch (error) {
      this.logger.error(`Agent invoke error for ${chatId}: ${error}`);
      await this.messaging.sendMessage(
        { chatId, type: "text", text: "Sorry, I ran into an error. Please try again." },
        message.platform,
      );
    }
  }

  // -------------------------------------------------------------------
  // Human-in-the-loop interrupt handling
  // -------------------------------------------------------------------

  private async handleInterrupt(
    chatId: string,
    platform: Platform,
    result: Record<string, any>,
    threadId: string,
  ) {
    const interruptData = result.__interrupt__?.[0]?.value;
    if (!interruptData?.actionRequests) {
      this.logger.warn(`Unexpected interrupt format for ${chatId}`);
      return;
    }

    // Store the pending interrupt
    this.pendingInterrupts.set(chatId, {
      threadId,
      interrupts: interruptData,
      platform,
    });

    // Format and send the approval request
    const actions = interruptData.actionRequests as Array<{
      name: string;
      args: Record<string, unknown>;
    }>;

    let text = "*Approval Required*\n\n";
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      text += `*${i + 1}. ${formatToolName(action.name)}*\n`;
      text += formatArgs(action.args);
      text += "\n";
    }
    text += 'Reply *approve* to proceed or *reject* to cancel.';

    await this.messaging.sendMessage({ chatId, type: "text", text }, platform);
  }

  private async handleInterruptResponse(message: IncomingMessage) {
    const chatId = message.chatId;
    const pending = this.pendingInterrupts.get(chatId);
    if (!pending) return;

    const userText = (message.text ?? "").toLowerCase().trim();

    // Determine user decision
    let decisions: Array<{ type: string }>;

    if (["approve", "yes", "ok", "haan", "ha", "theek hai"].includes(userText)) {
      decisions = pending.interrupts.actionRequests.map(() => ({ type: "approve" }));
    } else if (["reject", "no", "nahi", "cancel", "nah", "mat karo"].includes(userText)) {
      decisions = pending.interrupts.actionRequests.map(() => ({ type: "reject" }));
    } else {
      // Not a clear approve/reject — treat as a new message, drop the interrupt
      this.pendingInterrupts.delete(chatId);
      await this.processMessage(message);
      return;
    }

    this.pendingInterrupts.delete(chatId);

    const config = { configurable: { thread_id: pending.threadId } };

    try {
      const result = await this.agent.invoke(
        new Command({ resume: { decisions } }),
        { ...config, recursionLimit: 50 },
      );

      // Check for chained interrupts
      if (result.__interrupt__) {
        await this.handleInterrupt(chatId, pending.platform, result, pending.threadId);
        return;
      }

      const reply = this.extractReply(result);
      if (reply) {
        await this.messaging.sendMessage(
          { chatId, type: "text", text: reply },
          pending.platform,
        );
      }
    } catch (error) {
      this.logger.error(`Resume error for ${chatId}: ${error}`);
      await this.messaging.sendMessage(
        { chatId, type: "text", text: "Error processing your approval. Please try again." },
        pending.platform,
      );
    }
  }

  // -------------------------------------------------------------------
  // Thread management
  // -------------------------------------------------------------------

  private getOrCreateThread(chatId: string): string {
    if (!this.threadMap.has(chatId)) {
      this.threadMap.set(chatId, `thread-${chatId}-${Date.now()}`);
      this.logger.debug(`New thread for chat ${chatId}`);
    }
    return this.threadMap.get(chatId)!;
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  private extractReply(result: Record<string, any>): string | null {
    const messages: any[] = result.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) return null;

    // Walk backwards to find the last AI message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const msgType = msg._getType?.() ?? msg.type ?? "";
      if (msgType === "ai" && msg.content) {
        if (typeof msg.content === "string") return msg.content;
        if (Array.isArray(msg.content)) {
          return msg.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n");
        }
        return JSON.stringify(msg.content);
      }
    }
    return null;
  }

  /** Get agent info for health checks. */
  getInfo() {
    return {
      status: this.agent ? "initialized" : "not_initialized",
      subagents: [
        "taste-learner",
        "diet-tracker",
        "social-planner",
        "chef-comm",
        "grocery-executor",
      ],
      interruptOn: [
        "send_whatsapp_message",
        "send_telegram_message",
        "place_order",
        "update_diet",
      ],
    };
  }
}

// -------------------------------------------------------------------
// Formatting helpers for interrupt messages
// -------------------------------------------------------------------

function formatToolName(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatArgs(args: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const label = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    if (typeof value === "string") {
      lines.push(`  ${label}: ${value.length > 120 ? value.slice(0, 120) + "..." : value}`);
    } else if (Array.isArray(value)) {
      lines.push(`  ${label}: ${value.length} item(s)`);
    } else {
      lines.push(`  ${label}: ${JSON.stringify(value)}`);
    }
  }
  return lines.join("\n") + "\n";
}

// -------------------------------------------------------------------
// System prompt
// -------------------------------------------------------------------

const ORCHESTRATOR_SYSTEM_PROMPT = `You are MealPrep, an AI-powered meal planning assistant that helps users plan meals, coordinate with their cook, and order groceries.

## Identity
- Helpful, proactive, and concise
- Communicate in the same language as the user (Hindi, English, or Hinglish)
- Deep understanding of Indian food culture — cuisines, festivals, seasonal cooking, home cooking patterns

## Capabilities
You have specialized subagents. DELEGATE to them using the task() tool for focused work:
1. **taste-learner** — Analyzes food photos, voice notes, recipe shares, and feedback to build a taste profile
2. **diet-tracker** — Manages diet plans (keto, vegan, IF, etc.), validates meals against constraints
3. **social-planner** — Coordinates group dinners by merging taste profiles of multiple users
4. **chef-comm** — Communicates with the cook via WhatsApp/Telegram (translates plans into cooking instructions)
5. **grocery-executor** — Orders groceries from Zepto/Blinkit

## Behavior
- Acknowledge the user's message before heavy processing
- When suggesting meals, read /taste/profile.md and /diet/active-plan.md first
- For group dinners, gather all guest preferences before planning
- NEVER order groceries or message the chef without explicit user approval
- Use your memory files to remember preferences across conversations
- Keep responses short and actionable — this is a chat interface

## Memory Files
- /memories/AGENT.md — Persistent notes about this user
- /taste/profile.md — Structured taste profile
- /diet/active-plan.md — Current diet plan and restrictions

Update these files when you learn new information. Read them to personalize suggestions.`;
