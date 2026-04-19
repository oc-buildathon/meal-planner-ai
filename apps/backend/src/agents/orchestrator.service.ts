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
import { ConfigService } from "@nestjs/config";
import { LlmService } from "../llm/llm.service";
import { MessagingService } from "../messaging/messaging.service";
import type { IncomingMessage, Platform } from "../messaging/messaging.types";
import { AgentMemoryService } from "./memory/memory.service";
import { UsersService } from "../database/users.service";
import { GroupMealsService } from "../database/group-meals.service";

// Subagents
import {
  tasteLearnerSubagent,
  dietTrackerSubagent,
  createSocialPlannerSubagent,
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
  /** Cache key for the per-user agent that raised this interrupt. */
  cacheKey: string;
  /** Namespace the agent was bound to (used if we need to rebuild it). */
  namespace: string[];
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

  /**
   * Per-user compiled deep-agent graph cache.
   * Key: namespace key (e.g. `"user:42"` or `"guest:<chatId>"`).
   * Each agent is bound to a user-specific StoreBackend namespace, giving
   * true memory isolation between users.
   */
  private agents = new Map<string, any>();

  /** Map chatId -> threadId for conversation continuity */
  private threadMap = new Map<string, string>();

  /** Map chatId -> pending interrupt awaiting user decision */
  private pendingInterrupts = new Map<string, PendingInterrupt>();

  /** True once the memory layer is ready — we can create user agents on demand. */
  private ready = false;

  constructor(
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(AgentMemoryService) private readonly memory: AgentMemoryService,
    @Inject(MessagingService) private readonly messaging: MessagingService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(GroupMealsService) private readonly groupMeals: GroupMealsService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    // Agents are built lazily per user on first message. We just register
    // ourselves as the message processor and mark ready.
    this.ready = true;
    this.messaging.setMessageProcessor((msg) => this.processMessage(msg));
    this.logger.log(
      "Orchestrator ready (agents are created per-user on demand)",
    );
  }

  // -------------------------------------------------------------------
  // Per-user agent construction
  // -------------------------------------------------------------------

  /**
   * Return the compiled deep agent for a specific user namespace.
   *
   * The namespace scopes every `/memories/`, `/taste/`, `/diet/`, etc.
   * write through the LangGraph store, so one user cannot read or
   * overwrite another user's taste profile or diet plan.
   *
   * Agents are cached by namespace key so a returning user gets the
   * same compiled graph (no re-compilation cost per message).
   */
  private async getAgentForNamespace(
    cacheKey: string,
    userNs: string[],
  ): Promise<any> {
    const cached = this.agents.get(cacheKey);
    if (cached) return cached;

    const model = this.llm.getModel();
    const skillsNs = AgentMemoryService.SKILLS_NAMESPACE;

    // Chef-comm needs MessagingService; social-planner needs DB + messaging
    const chefCommSubagent = createChefCommSubagent(this.messaging);

    // Mini-App URL (only meaningful when WEBAPP_ENABLED=true AND served on
    // a public HTTPS origin). Pass empty string otherwise — the tool will
    // fall back to the text-list flow.
    const webAppEnabled =
      this.config.get<boolean>("webapp.enabled") ?? false;
    const webAppUrl = webAppEnabled
      ? this.buildWebAppUrl(this.config.get<string>("webapp.url") ?? "")
      : "";

    const socialPlannerSubagent = createSocialPlannerSubagent({
      users: this.users,
      groupMeals: this.groupMeals,
      messaging: this.messaging,
      memory: this.memory,
      llm: this.llm,
      webAppUrl,
      broadcastPlan: (requestId, planText) =>
        this.broadcastPlanToParticipants(requestId, planText),
      autoRespondForPersona: (userId, question) =>
        this.generatePersonaResponse(userId, question),
    });

    const agent = await createDeepAgent({
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

      // Human-in-the-loop: pause ONLY before actions that spend money
      // or make permanent / high-stakes changes. Everything else runs
      // without re-confirming — if the user said "plan a meal with X",
      // that's the approval, don't ask again.
      //
      // Chef-comm subagent still gates its own send_*_message calls
      // internally because the CHEF is a real human who should not be
      // spammed without user oversight.
      interruptOn: {
        place_order: true,
        update_diet: { allowedDecisions: ["approve", "reject"] },
      },

      // Composite backend:
      //   - StateBackend for scratch (per-invocation)
      //   - StoreBackend per domain, split into TWO isolation planes:
      //       user-scoped namespace  → private memory
      //       shared skills namespace → global knowledge base
      backend: new CompositeBackend(
        new StateBackend(),
        {
          "/memories/":     new StoreBackend({ namespace: userNs }),
          "/taste/":        new StoreBackend({ namespace: userNs }),
          "/diet/":         new StoreBackend({ namespace: userNs }),
          "/chat-history/": new StoreBackend({ namespace: userNs }),
          "/orders/":       new StoreBackend({ namespace: userNs }),
          "/social/":       new StoreBackend({ namespace: userNs }),
          "/skills/":       new StoreBackend({ namespace: skillsNs }),
        },
      ),

      store: this.memory.store,
      checkpointer: this.memory.checkpointer,
    });

    this.agents.set(cacheKey, agent);
    this.logger.log(
      `Deep agent created for ${cacheKey} (namespace=${userNs.join("/")})`,
    );
    return agent;
  }

  /**
   * Resolve the right (cacheKey, namespace) pair for a message.
   *
   * If the adapter already upserted a `dbUserId`, we use the user-scoped
   * namespace. Otherwise (e.g. HTTP test endpoint, unknown adapter) we
   * fall back to a chat-scoped "guest" namespace so isolation still
   * holds for test/debug traffic.
   */
  private resolveNamespace(message: IncomingMessage): {
    cacheKey: string;
    namespace: string[];
    userKey: string;
  } {
    if (message.dbUserId !== undefined) {
      const ns = AgentMemoryService.userNamespace(message.dbUserId);
      return {
        cacheKey: `user:${message.dbUserId}`,
        namespace: ns,
        userKey: String(message.dbUserId),
      };
    }
    // Guest: scope by platform + chatId
    const guestId = `${message.platform}:${message.chatId}`;
    return {
      cacheKey: `guest:${guestId}`,
      namespace: ["mealprep-agent", "guest", guestId],
      userKey: `guest:${guestId}`,
    };
  }

  // -------------------------------------------------------------------
  // Message processing (called by MessagingService)
  // -------------------------------------------------------------------

  async processMessage(message: IncomingMessage): Promise<void> {
    if (!this.ready) {
      this.logger.warn("Orchestrator not ready — skipping message");
      return;
    }

    const chatId = message.chatId;

    // If there's a pending interrupt for this chat, handle the response
    if (this.pendingInterrupts.has(chatId)) {
      await this.handleInterruptResponse(message);
      return;
    }

    // Telegram Mini App → bot: handle the picker selection directly,
    // bypassing the agent entirely (the initiator's click IS the intent).
    if (message.type === "web_app_data" && message.webAppData) {
      await this.handleWebAppSelection(message);
      return;
    }

    // If this user has a pending group-meal invite from someone else,
    // treat this message as their response — do not invoke the agent.
    if (
      message.dbUserId !== undefined &&
      message.type === "text" &&
      message.text
    ) {
      const handled = await this.handleGroupMealResponse(message);
      if (handled) return;
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

    // Prefix with sender name AND internal id so the agent can pass
    // the initiator's id to group-meal tools without hallucinating it.
    const idNote =
      message.dbUserId !== undefined
        ? ` (initiator_id=${message.dbUserId})`
        : "";
    const content = message.senderName
      ? `[${message.senderName}${idNote}]: ${message.text}`
      : `${idNote ? idNote + " " : ""}${message.text}`;

    const { cacheKey, namespace, userKey } = this.resolveNamespace(message);

    // Seed this user's memory files on first contact (idempotent).
    try {
      await this.memory.ensureUserMemorySeeded(userKey);
    } catch (e) {
      this.logger.warn(`Seeding memory failed for ${userKey}: ${e}`);
    }

    let agent: any;
    try {
      agent = await this.getAgentForNamespace(cacheKey, namespace);
    } catch (error) {
      this.logger.error(`Failed to build agent for ${cacheKey}: ${error}`);
      await this.messaging.sendMessage(
        {
          chatId,
          type: "text",
          text: "Sorry, I can't process your message right now. Please try again.",
        },
        message.platform,
      );
      return;
    }

    const threadId = this.getOrCreateThread(chatId, message.dbUserId);
    const config = { configurable: { thread_id: threadId } };

    try {
      const result = await agent.invoke(
        { messages: [{ role: "user", content }] },
        { ...config, recursionLimit: 50 },
      );

      // Check if the agent paused for human approval
      if (result.__interrupt__) {
        await this.handleInterrupt(
          chatId,
          message.platform,
          result,
          threadId,
          cacheKey,
          namespace,
        );
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
  // Group-meal response correlation
  // -------------------------------------------------------------------

  /**
   * If this user has an open `invited` row in a group_meal_request, treat
   * their next text message as the requested response and record it.
   *
   * Returns true if the message was consumed as a group-meal response
   * (and the caller should skip normal agent processing).
   */
  private async handleGroupMealResponse(
    message: IncomingMessage,
  ): Promise<boolean> {
    const userId = message.dbUserId;
    if (userId === undefined || !message.text) return false;

    const pending = this.groupMeals.findPendingForUser(userId);
    if (!pending) return false;

    const text = message.text.trim();
    const lower = text.toLowerCase();
    const isDecline = ["decline", "no", "skip", "nahi", "nah"].includes(lower);

    if (isDecline) {
      const { request, participants, allCollected } =
        this.groupMeals.recordDecline(pending.request.id, userId);
      await this.messaging.sendMessage(
        {
          chatId: message.chatId,
          type: "text",
          text: `Noted — you declined the group meal "${request.title}". The organizer will be informed.`,
          replyToMessageId: message.id,
        },
        message.platform,
      );
      if (allCollected) {
        await this.notifyInitiatorOfCompletion(request.id, participants);
      }
    } else {
      const { request, participants, allCollected } =
        this.groupMeals.recordResponse(pending.request.id, userId, text);

      // Confirm to the responder
      await this.messaging.sendMessage(
        {
          chatId: message.chatId,
          type: "text",
          text: `Got it, thanks! Your preferences for "${request.title}" have been recorded and shared with the organizer.`,
          replyToMessageId: message.id,
        },
        message.platform,
      );

      // If this was the last response, notify the initiator in their chat
      if (allCollected) {
        await this.notifyInitiatorOfCompletion(request.id, participants);
      }
    }

    return true;
  }

  /**
   * Telegram Mini App → bot: the initiator picked participants in the
   * picker and hit Confirm. We parse the payload, create the request,
   * and DM each picked participant, all without re-entering the agent.
   *
   * Expected payload shape (JSON, produced by `select-users.html`):
   *   { action: "invite_participants", participantIds: number[], title: string }
   */
  private async handleWebAppSelection(
    message: IncomingMessage,
  ): Promise<void> {
    if (!message.webAppData) return;
    const initiator = message.dbUserId
      ? this.users.findById(message.dbUserId)
      : null;
    if (!initiator) {
      await this.messaging.sendMessage(
        {
          chatId: message.chatId,
          type: "text",
          text: "Couldn't identify you — please send a plain text message first so the bot can register you, then try again.",
        },
        message.platform,
      );
      return;
    }

    let payload: any;
    try {
      payload = JSON.parse(message.webAppData);
    } catch (e) {
      this.logger.warn(`WebApp payload JSON parse failed: ${e}`);
      return;
    }

    if (payload?.action !== "invite_participants") {
      this.logger.warn(`Unknown WebApp action: ${payload?.action}`);
      return;
    }

    const ids: number[] = Array.isArray(payload.participantIds)
      ? payload.participantIds
          .map((n: unknown) => Number(n))
          .filter((n: number) => Number.isFinite(n) && n > 0)
      : [];
    const title: string =
      typeof payload.title === "string" && payload.title.trim().length > 0
        ? payload.title.trim().slice(0, 120)
        : "Group meal";

    if (ids.length === 0) {
      await this.messaging.sendMessage(
        {
          chatId: message.chatId,
          type: "text",
          text: "No one was selected — tap the picker again when you're ready.",
        },
        message.platform,
      );
      return;
    }

    // Resolve + validate participants
    const participants = ids
      .map((id) => this.users.findById(id))
      .filter((u): u is NonNullable<typeof u> => !!u && !u.is_bot && u.id !== initiator.id);

    if (participants.length === 0) {
      await this.messaging.sendMessage(
        {
          chatId: message.chatId,
          type: "text",
          text: "Couldn't find any of those users. Try the picker again.",
        },
        message.platform,
      );
      return;
    }

    // Persist and DM
    const { request, participants: partRows } = this.groupMeals.createRequest({
      initiatorId: initiator.id,
      title,
      prompt: null,
      participantIds: participants.map((u) => u.id),
    });

    const initiatorName =
      [initiator.first_name, initiator.last_name].filter(Boolean).join(" ") ||
      initiator.username ||
      `User#${initiator.id}`;

    const question = "What would you like to eat? (any cuisine / dish / dietary needs)";
    const invite = [
      `*${initiatorName}* is planning a group meal: *${title}*`,
      "",
      question,
      "",
      "Reply with your preferences, or say *decline* to skip.",
    ].join("\n");

    const delivered: string[] = [];
    const autoResponded: string[] = [];
    const failed: string[] = [];
    let autoCollectedComplete = false;

    for (const u of participants) {
      if (u.is_persona) {
        // Personas aren't real phones — synthesize their reply from their
        // stored profile and record it straight into the request.
        try {
          const text = await this.generatePersonaResponse(u.id, question);
          const { allCollected } = this.groupMeals.recordResponse(
            request.id,
            u.id,
            text,
          );
          autoCollectedComplete = autoCollectedComplete || allCollected;
          autoResponded.push(`${userLabel(u)} → "${text.slice(0, 80)}…"`);
        } catch (e) {
          failed.push(`${userLabel(u)} [persona] (error: ${e})`);
          this.logger.warn(`Persona auto-respond failed for ${u.id}: ${e}`);
        }
        continue;
      }

      try {
        await this.messaging.sendMessage(
          { chatId: u.chat_id, type: "text", text: invite },
          u.platform,
        );
        delivered.push(userLabel(u));
      } catch (e) {
        failed.push(`${userLabel(u)} (error: ${e})`);
        this.logger.warn(`Failed to invite ${u.id}: ${e}`);
      }
    }

    // If we're about to auto-plan (all personas resolved synchronously),
    // skip the verbose "group meal created / invited N people" message
    // and let `notifyInitiatorOfCompletion` send the single consolidated
    // status line + drive planning. Otherwise send a short confirmation.
    if (!autoCollectedComplete) {
      const confirmLines: string[] = [
        `Planning *"${title}"* — invited ${partRows.length} ${
          partRows.length === 1 ? "person" : "people"
        }.`,
      ];
      if (delivered.length > 0) {
        confirmLines.push(
          ...delivered.map((s) => `  ✓ ${s}`),
        );
      }
      if (autoResponded.length > 0) {
        confirmLines.push(
          "",
          `Personas replied instantly (${autoResponded.length}). Waiting on the rest — I'll send the plan as soon as everyone's in.`,
        );
      } else {
        confirmLines.push("", "I'll send you the plan as soon as they reply.");
      }
      if (failed.length > 0) {
        confirmLines.push("", ...failed.map((s) => `  ✗ ${s}`));
      }
      await this.messaging.sendMessage(
        { chatId: message.chatId, type: "text", text: confirmLines.join("\n") },
        message.platform,
      );
    }

    // Everything collected in one shot — drive the plan now.
    if (autoCollectedComplete) {
      const parts = this.groupMeals.getParticipants(request.id);
      await this.notifyInitiatorOfCompletion(request.id, parts);
    }
  }

  /**
   * Synthesize a group-meal response from a seeded persona's stored
   * taste profile + diet plan. Uses the configured LLM to write in the
   * persona's voice, constrained by their allergies/restrictions.
   *
   * Safe by construction — if the store read fails or the LLM returns
   * nothing usable, we fall back to a terse, restriction-aware reply
   * so the group-meal flow doesn't block.
   */
  private async generatePersonaResponse(
    userId: number,
    question: string,
  ): Promise<string> {
    const user = this.users.findById(userId);
    if (!user) return "(persona not found)";

    const ns = AgentMemoryService.userNamespace(user.id);
    const taste = await this.memory.store.get(ns, "/taste/profile.md");
    const diet = await this.memory.store.get(ns, "/diet/active-plan.md");

    const tasteText = fileDataContent(taste?.value);
    const dietText = fileDataContent(diet?.value);
    const name =
      [user.first_name, user.last_name].filter(Boolean).join(" ") ||
      user.username ||
      `User #${user.id}`;

    if (!tasteText && !dietText) {
      return `(no profile on file for ${name})`;
    }

    const systemPrompt = `You are role-playing as ${name}, responding to a friend inviting you to plan a group meal.

Write in ${name}'s voice based ONLY on the taste profile and diet plan below.

Rules:
- Reply in 2-4 short sentences, Hinglish (Hindi+English mix, casual).
- Name 2-3 SPECIFIC dishes from their favourites/profile they'd actually want.
- If they have allergies or strict dietary rules (especially critical ones like "no legumes" or "no dairy" or "no non-veg on Monday"), STATE them clearly so the host knows.
- Do not invent dishes not grounded in the profile.
- Do not mention being an AI or a persona — you are ${name}.`;

    const userPrompt = `Your taste profile:
${tasteText || "(none)"}

Your diet/restrictions:
${dietText || "(none)"}

Friend's message: "${question}"

Reply:`;

    try {
      const reply = await this.llm.complete(userPrompt, systemPrompt);
      const trimmed = (reply ?? "").trim();
      if (trimmed.length > 0) return trimmed;
    } catch (e) {
      this.logger.warn(`Persona LLM response failed for ${user.id}: ${e}`);
    }

    // Fallback: restriction-aware terse answer built from profile text.
    return buildFallbackPersonaReply(name, tasteText, dietText);
  }

  /**
   * Broadcast the final meal plan to every participant of a group-meal
   * request. Called by the agent via the `broadcast_plan_to_participants`
   * tool once the initiator approves the plan.
   *
   * Returns a short status summary (delivered / failed counts) for the
   * tool caller to surface to the agent.
   */
  async broadcastPlanToParticipants(
    requestId: number,
    planText: string,
  ): Promise<{ delivered: number; failed: number; total: number }> {
    const req = this.groupMeals.findRequest(requestId);
    if (!req) return { delivered: 0, failed: 0, total: 0 };

    // Deliver ONLY to invited participants — the initiator is already
    // getting the plan as the agent's reply in their own chat, so
    // including them here would show the plan twice. Skip personas
    // (they have no real chat to DM). Skip declined participants.
    const parts = this.groupMeals.getParticipants(requestId);
    const recipients = parts
      .filter((p) => p.participant.status === "responded")
      .map((p) => p.user)
      .filter((u) => u.is_persona !== 1);

    const header =
      `*Shared plan for "${req.title}"*\n\n${planText.trim()}`;

    let delivered = 0;
    let failed = 0;
    for (const u of recipients) {
      try {
        await this.messaging.sendMessage(
          { chatId: u.chat_id, type: "text", text: header },
          u.platform,
        );
        delivered++;
      } catch (e) {
        failed++;
        this.logger.warn(`Broadcast failed to user ${u.id}: ${e}`);
      }
    }
    return { delivered, failed, total: recipients.length };
  }

  /**
   * Build the absolute HTTPS URL of the Mini App endpoint.
   * Accepts either a bare origin (`https://bot.example.com`) or an already
   * fully-qualified URL, and appends `/webapp/select-users` if missing.
   */
  private buildWebAppUrl(configured: string): string {
    if (!configured) return "";
    try {
      const u = new URL(configured);
      if (!u.pathname || u.pathname === "/") {
        u.pathname = "/webapp/select-users";
      }
      return u.toString();
    } catch {
      this.logger.warn(
        `Invalid WEBAPP_URL=${configured} — Mini App picker disabled.`,
      );
      return "";
    }
  }

  /**
   * Called when every invited participant has either responded or
   * declined. Sends a concise status line to the initiator and then
   * IMMEDIATELY runs the agent on a synthetic "plan it now" turn so
   * the meal plan is generated + broadcast without any further user
   * tap.
   *
   * The user's experience becomes:
   *   (invite message)  →  (responses collected)  →  (plan arrives)
   * instead of the earlier:
   *   (invite)  →  (approval ping)  →  (responses)  →  ("reply with
   *                anything to plan")  →  (user taps)  →  (plan).
   */
  private async notifyInitiatorOfCompletion(
    requestId: number,
    participants: Array<{
      participant: { status: string; response_text: string | null };
      user: { id: number; first_name: string | null; username: string | null };
    }>,
  ): Promise<void> {
    const request = this.groupMeals.findRequest(requestId);
    if (!request) return;
    const initiator = this.users.findById(request.initiator_id);
    if (!initiator) return;

    // One concise status message — then we go straight into planning.
    const responseLines = participants.map(({ participant, user }) => {
      const who =
        [user.first_name, user.username].filter(Boolean).join(" / ") ||
        `#${user.id}`;
      if (participant.status === "declined") return `• ${who}: _declined_`;
      return `• ${who}: ${participant.response_text ?? "(no preference given)"}`;
    });

    const summary =
      `*All responses in for "${request.title}":*\n\n` +
      responseLines.join("\n") +
      `\n\n_Generating plan…_`;

    await this.messaging.sendMessage(
      { chatId: initiator.chat_id, type: "text", text: summary },
      initiator.platform,
    );

    // Auto-continue — drive the agent on the initiator's thread to
    // merge + plan + broadcast in a single chained invocation. No user
    // tap required.
    await this.runAutoPlan(request.id, initiator);
  }

  /**
   * Inject a synthetic, agent-only turn that instructs the orchestrator
   * to merge palettes for this request, produce a plan, and broadcast it
   * to every participant. Errors are swallowed so the user's chat isn't
   * left in a half-state.
   */
  private async runAutoPlan(
    requestId: number,
    initiator: { id: number; chat_id: string; platform: Platform; platform_user_id: string; first_name: string | null; username: string | null },
  ): Promise<void> {
    const synthetic: IncomingMessage = {
      id: `auto-plan-${requestId}-${Date.now()}`,
      platform: initiator.platform,
      senderId: initiator.platform_user_id,
      senderName:
        initiator.first_name || initiator.username || `user#${initiator.id}`,
      chatId: initiator.chat_id,
      isGroup: false,
      type: "text",
      text:
        `[auto-continuation] All participants have responded for group-meal request id ${requestId}. ` +
        `Do this in ONE sequence WITHOUT asking the user for any confirmation: ` +
        `(1) call merge_palettes({ requestId: ${requestId} }); ` +
        `(2) call plan_group_dinner with the merged palette text verbatim, guestCount from the number of participants, and the appropriate date/mealType; ` +
        `(3) send the plan as your final reply to the user; ` +
        `(4) call broadcast_plan_to_participants({ requestId: ${requestId}, planText: <same plan> }) so every invitee sees it in their own chat. ` +
        `Reply in WhatsApp/Telegram-compatible format only (single *bold*, _italic_, "• " bullets). Keep it tight.`,
      timestamp: new Date(),
      dbUserId: initiator.id,
    };

    try {
      await this.processMessage(synthetic);
    } catch (e) {
      this.logger.warn(`Auto-plan failed for request ${requestId}: ${e}`);
      await this.messaging.sendMessage(
        {
          chatId: initiator.chat_id,
          type: "text",
          text: "I couldn't auto-generate the plan. Say 'plan it' and I'll retry.",
        },
        initiator.platform,
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
    cacheKey: string,
    namespace: string[],
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
      cacheKey,
      namespace,
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
      const agent = await this.getAgentForNamespace(
        pending.cacheKey,
        pending.namespace,
      );
      const result = await agent.invoke(
        new Command({ resume: { decisions } }),
        { ...config, recursionLimit: 50 },
      );

      // Check for chained interrupts
      if (result.__interrupt__) {
        await this.handleInterrupt(
          chatId,
          pending.platform,
          result,
          pending.threadId,
          pending.cacheKey,
          pending.namespace,
        );
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

  /**
   * Resolve the langgraph thread_id for this chat.
   *
   * Priority:
   *   1. In-memory cache (hot path — same process lifecycle)
   *   2. SQLite `users.thread_id` (survives restarts)
   *   3. Generate a new id, persist it to SQLite (if we have a dbUserId), cache it.
   */
  private getOrCreateThread(chatId: string, dbUserId?: number): string {
    const cached = this.threadMap.get(chatId);
    if (cached) return cached;

    // Look up persisted thread id from SQLite if we have a user row
    if (dbUserId !== undefined) {
      try {
        const row = this.users.findById(dbUserId);
        if (row?.thread_id) {
          this.threadMap.set(chatId, row.thread_id);
          return row.thread_id;
        }
      } catch (e) {
        this.logger.debug(`Thread lookup failed for user ${dbUserId}: ${e}`);
      }
    }

    const fresh = `thread-${chatId}-${Date.now()}`;
    this.threadMap.set(chatId, fresh);

    if (dbUserId !== undefined) {
      try {
        this.users.setThreadId(dbUserId, fresh);
      } catch (e) {
        this.logger.warn(`Persist thread id failed for user ${dbUserId}: ${e}`);
      }
    }

    this.logger.debug(`New thread ${fresh} for chat ${chatId}`);
    return fresh;
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
      status: this.ready ? "ready" : "not_ready",
      isolation: "per-user",
      cachedAgents: this.agents.size,
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

function fileDataContent(fd: any): string {
  if (!fd) return "";
  if (fd.content && Array.isArray(fd.content)) return fd.content.join("\n");
  if (typeof fd.content === "string") return fd.content;
  return "";
}

function buildFallbackPersonaReply(
  name: string,
  tasteText: string,
  dietText: string,
): string {
  const bits: string[] = [`${name}:`];
  // Surface any ALL-CAPS "CRITICAL" or "NEVER" lines from the diet as hard no-s.
  const hardRules = (dietText || "")
    .split("\n")
    .filter((l) => /CRITICAL|NEVER|STRICT/.test(l))
    .slice(0, 2)
    .map((l) => l.replace(/[*#-]/g, "").trim())
    .filter(Boolean);
  if (hardRules.length > 0) {
    bits.push("Heads up:", ...hardRules.map((r) => `- ${r}`));
  }
  // Grab the "Top Dishes" section if present.
  const topMatch = (tasteText || "").match(
    /Top Dishes[^\n]*\n((?:[-*\d].*\n){1,6})/i,
  );
  if (topMatch) {
    bits.push("I'd love:", topMatch[1].trim());
  }
  return bits.join("\n");
}

function userLabel(u: {
  id: number;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  platform: string;
}): string {
  const name =
    [u.first_name, u.last_name].filter(Boolean).join(" ").trim() ||
    u.username ||
    `user#${u.id}`;
  const handle = u.username ? ` (@${u.username})` : "";
  return `${name}${handle} [${u.platform}]`;
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

IMPORTANT: These are the ONLY subagent types you may invoke. The allowed types are EXACTLY:
  taste-learner, diet-tracker, social-planner, chef-comm, grocery-executor
Do NOT invent or use any other subagent type (e.g. "greeting-responder", "general", etc.).
For simple messages like greetings, questions, or casual chat — reply DIRECTLY without delegating to any subagent.

## Behavior
- For greetings, small talk, or simple questions — respond directly yourself. No subagent needed.
- Acknowledge briefly, then act. Don't ask for confirmation when the user has already told you what they want.
- When suggesting meals, read /taste/profile.md and /diet/active-plan.md first
- For group meals: delegate to social-planner via task(). The user's
  message carries a runtime note "(initiator_id=<n>)" — pass that as
  \`initiatorId\` / \`excludeUserId\`.

  CRITICAL — ONE-SHOT group-meal flow:
    * If the user NAMES people (by @username, first name, or id):
      call request_meal_options_from_user DIRECTLY — NO picker, NO
      "should I invite them?", NO intermediate approval.
    * After that tool returns, READ its "NEXT STEP" block and follow it
      verbatim: merge_palettes → plan_group_dinner → broadcast_plan_to_participants.
      Do NOT stop to ask the user "should I merge now?". The user's
      original request is all the approval needed.
    * If a participant hasn't replied yet, the system will auto-drive
      the plan for you when their response lands — you just have to do
      the invite step correctly.

- NEVER order groceries without explicit approval (interruptOn enforces it).
- NEVER message the chef without explicit approval (chef-comm subagent enforces it).
- DM-ing friends / family who are registered users to ASK them about
  their meal preferences is safe — you may do it without re-confirming.
- Use your memory files to remember preferences across conversations.
- Keep responses short and actionable — this is a chat interface.

## Memory Files
- /memories/AGENT.md — Persistent notes about this user
- /taste/profile.md — Structured taste profile
- /diet/active-plan.md — Current diet plan and restrictions

Update these files when you learn new information. Read them to personalize suggestions.

## Output formatting — IMPORTANT
You are talking over WhatsApp and Telegram. Use ONLY the following formatting:
- *bold* — single asterisks (never double)
- _italic_ — single underscores
- \`code\` — single backticks
- Bullet lists with "• " at line start (never "- " or "* ")
- Plain numbered lists with "1. " / "2. " are fine
- DO NOT use markdown headers (#, ##), tables, links like [text](url), code fences (\`\`\`), or HTML tags.
- DO NOT use double-asterisk **bold** — it looks ugly on WhatsApp.
- Keep replies short enough to read on a phone screen. Break into 2-3 short lines rather than one wall of text.`;
