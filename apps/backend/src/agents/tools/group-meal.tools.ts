import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { UsersService, UserRow } from "../../database/users.service";
import type { GroupMealsService } from "../../database/group-meals.service";
import type { MessagingService } from "../../messaging/messaging.service";

/**
 * Callbacks the orchestrator injects into the social-planner tools.
 * Kept narrow so the tools don't import the full orchestrator (which
 * would be a circular dep).
 */
export interface GroupMealToolDeps {
  users: UsersService;
  groupMeals: GroupMealsService;
  messaging: MessagingService;
  /** Public HTTPS URL of `/webapp/select-users`. Empty = picker disabled. */
  webAppUrl?: string;
  /** Broadcast a final plan to every participant; returns delivery counts. */
  broadcastPlan?: (
    requestId: number,
    planText: string,
  ) => Promise<{ delivered: number; failed: number; total: number }>;
  /**
   * Synthesize a group-meal response for a seeded persona user
   * (is_persona=1). The tool calls this instead of DM-ing when the
   * invitee is a persona. Returns the text the persona would've replied.
   */
  autoRespondForPersona?: (
    userId: number,
    question: string,
  ) => Promise<string>;
}

/**
 * Tools used by the social-planner subagent to coordinate a group meal
 * with OTHER users who also use the bot.
 *
 * - list_available_users          — show registered users to the initiator
 * - request_meal_options_from_user — DM a user asking for their meal prefs
 * - check_group_meal_status        — poll responses gathered so far
 *
 * These close over the DB + MessagingService so the agent can act on
 * persistent multi-user state. `request_meal_options_from_user` is wired
 * into the orchestrator's `interruptOn` config so the initiator must
 * approve before a DM is sent to another user.
 */
export function createGroupMealTools(deps: GroupMealToolDeps) {
  const {
    users,
    groupMeals,
    messaging,
    webAppUrl,
    broadcastPlan,
    autoRespondForPersona,
  } = deps;

  // ---- formatters -------------------------------------------------

  const fmtUser = (u: UserRow): string => {
    const name =
      [u.first_name, u.last_name].filter(Boolean).join(" ").trim() ||
      u.username ||
      `user#${u.id}`;
    const handle = u.username ? ` (@${u.username})` : "";
    return `#${u.id} — ${name}${handle} [${u.platform}]`;
  };

  // ---- list_available_users --------------------------------------

  const listAvailableUsers = tool(
    async ({ excludeUserId, limit }: { excludeUserId?: number; limit?: number }) => {
      const all = users.list(limit ?? 50);
      const filtered = excludeUserId
        ? all.filter((u) => u.id !== excludeUserId && !u.is_bot)
        : all.filter((u) => !u.is_bot);

      if (filtered.length === 0) {
        return "No other users are registered yet. Ask the user to invite friends to start chatting with the bot first.";
      }

      const lines = filtered.map((u) => {
        const lastSeen = u.last_seen_at.replace("T", " ").slice(0, 16);
        return `${fmtUser(u)} — last seen ${lastSeen}, ${u.message_count} msgs`;
      });

      return [
        `${filtered.length} registered user(s) available for group meals:`,
        "",
        ...lines,
        "",
        "Ask the user which of these to include (accept IDs like '#3' or @usernames), then call request_meal_options_from_user for each.",
      ].join("\n");
    },
    {
      name: "list_available_users",
      description:
        "List registered users in the system (other than the caller) who can be invited to a group meal. " +
        "Returns each user's internal id, display name, @username, platform, and recent activity so the " +
        "orchestrator can present them to the initiator. Call this whenever the user asks to 'plan a meal " +
        "together' / 'with friends' / 'with other people'.",
      schema: z.object({
        excludeUserId: z
          .number()
          .optional()
          .describe(
            "The initiator's internal user id, which will be excluded from the returned list.",
          ),
        limit: z
          .number()
          .optional()
          .default(50)
          .describe("Max users to return (default 50)."),
      }),
    },
  );

  // ---- request_meal_options_from_user ----------------------------

  const requestMealOptionsFromUser = tool(
    async ({
      initiatorId,
      participantIds,
      title,
      prompt,
    }: {
      initiatorId: number;
      participantIds: number[];
      title: string;
      prompt?: string;
    }) => {
      const initiator = users.findById(initiatorId);
      if (!initiator) {
        return `Error: initiator user #${initiatorId} not found in database.`;
      }

      // Validate all participants exist
      const participants: UserRow[] = [];
      const missing: number[] = [];
      for (const pid of participantIds) {
        const u = users.findById(pid);
        if (u && !u.is_bot) participants.push(u);
        else missing.push(pid);
      }
      if (participants.length === 0) {
        return `Error: no valid participants found. Missing IDs: [${missing.join(", ")}]`;
      }

      // Persist the request
      const { request, participants: participantRows } = groupMeals.createRequest({
        initiatorId,
        title,
        prompt: prompt ?? null,
        participantIds: participants.map((u) => u.id),
      });

      // Build the invite text
      const initiatorName =
        [initiator.first_name, initiator.last_name].filter(Boolean).join(" ") ||
        initiator.username ||
        `User#${initiator.id}`;

      const question = prompt?.trim()
        ? prompt
        : `What would you like to eat? (any cuisine / dish preferences, dietary needs, cravings are welcome)`;

      const inviteText = [
        `*${initiatorName}* is planning a group meal: *${title}*`,
        "",
        question,
        "",
        "Reply with your preferences in the next message, or say *decline* to skip.",
      ].join("\n");

      // DM each participant on their own platform / chat — or
      // auto-respond for seeded personas.
      const delivered: string[] = [];
      const autoResponded: string[] = [];
      const failed: string[] = [];

      for (const p of participants) {
        if (p.is_persona) {
          if (!autoRespondForPersona) {
            failed.push(
              `${fmtUser(p)} [persona] (auto-respond not wired)`,
            );
            continue;
          }
          try {
            const text = await autoRespondForPersona(p.id, question);
            groupMeals.recordResponse(request.id, p.id, text);
            autoResponded.push(
              `${fmtUser(p)} → "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`,
            );
          } catch (e) {
            failed.push(`${fmtUser(p)} [persona] (error: ${e})`);
          }
          continue;
        }
        try {
          await messaging.sendMessage(
            { chatId: p.chat_id, type: "text", text: inviteText },
            p.platform,
          );
          delivered.push(fmtUser(p));
        } catch (e) {
          failed.push(`${fmtUser(p)} (error: ${e})`);
        }
      }

      // Determine whether every invite has already resolved (all
      // personas). If so, we can hand the agent the full response set
      // + an explicit next-action so it chains merge + plan + broadcast
      // in this same turn without waiting on anything.
      const allResolved = delivered.length === 0 && failed.length === 0;
      const parts = groupMeals.getParticipants(request.id);
      const collectedResponses = parts
        .filter((p) => p.participant.status !== "invited")
        .map((p) => {
          const who = fmtUser(p.user);
          if (p.participant.status === "declined") {
            return `  • ${who}: declined`;
          }
          return `  • ${who}: ${p.participant.response_text ?? "(empty)"}`;
        });

      const summary: string[] = [
        `Group meal request #${request.id} created: "${title}"`,
        `Initiator: ${fmtUser(initiator)}`,
        `Participants (${participantRows.length}):`,
        ...delivered.map((s) => `  ✓ ${s} — DM sent`),
        ...autoResponded.map((s) => `  ⚡ ${s}`),
        ...failed.map((s) => `  ✗ ${s}`),
      ];

      if (collectedResponses.length > 0) {
        summary.push("", "Responses collected so far:", ...collectedResponses);
      }

      summary.push("");
      if (allResolved) {
        summary.push(
          `NEXT STEP — all responses are in. Without asking the user, call in sequence:`,
          `  1) merge_palettes({ requestId: ${request.id} })`,
          `  2) plan_group_dinner with the merged text, guestCount=${parts.length}, date=<today-or-inferred>, mealType=<dinner|lunch|…>`,
          `  3) send the plan as your reply to the user`,
          `  4) broadcast_plan_to_participants({ requestId: ${request.id}, planText: <same plan> })`,
        );
      } else {
        summary.push(
          `Real participants DM'd — their replies will trigger an auto-plan. Do NOT re-ask the user for approval.`,
        );
      }
      return summary.join("\n");
    },
    {
      name: "request_meal_options_from_user",
      description:
        "Create a group-meal request and DM the selected participants asking for their meal preferences. " +
        "Each participant receives a message on their own platform (WhatsApp / Telegram) and their reply is " +
        "automatically captured as their response. Use AFTER calling list_available_users and confirming " +
        "the selection with the initiator. Requires the initiator's internal user id and a list of " +
        "participant user ids (from list_available_users).",
      schema: z.object({
        initiatorId: z
          .number()
          .describe("Internal user id of the person organizing the meal."),
        participantIds: z
          .array(z.number())
          .min(1)
          .describe("List of internal user ids to invite."),
        title: z
          .string()
          .describe(
            "Short title for this group meal (e.g. 'Saturday dinner', 'Diwali party').",
          ),
        prompt: z
          .string()
          .optional()
          .describe(
            "Optional custom question to ask participants. Defaults to a generic preferences prompt.",
          ),
      }),
    },
  );

  // ---- check_group_meal_status -----------------------------------

  const checkGroupMealStatus = tool(
    async ({ requestId }: { requestId: number }) => {
      const request = groupMeals.findRequest(requestId);
      if (!request) return `Request #${requestId} not found.`;

      const parts = groupMeals.getParticipants(requestId);
      const lines: string[] = [
        `Group meal #${request.id}: ${request.title}`,
        `Status: ${request.status}`,
        `Responses (${parts.filter((p) => p.participant.status === "responded").length}/${parts.length}):`,
      ];
      for (const { participant, user } of parts) {
        const head = fmtUser(user);
        if (participant.status === "invited") {
          lines.push(`  · ${head} — waiting…`);
        } else if (participant.status === "declined") {
          lines.push(`  · ${head} — declined`);
        } else {
          lines.push(
            `  · ${head} — ${participant.response_text ?? "(empty)"}`,
          );
        }
      }
      return lines.join("\n");
    },
    {
      name: "check_group_meal_status",
      description:
        "Poll the current response state of a group-meal request. Returns each participant's status " +
        "(invited / responded / declined) and their reply text. Use after request_meal_options_from_user " +
        "if the user asks 'who has replied?' or before merging palettes.",
      schema: z.object({
        requestId: z
          .number()
          .describe("Internal id of the group meal request (from request_meal_options_from_user)."),
      }),
    },
  );

  // ---- show_participant_picker ----------------------------------
  //
  // Opens a Telegram Mini App inside the initiator's chat that renders
  // every registered user as a selectable row. The initiator taps the
  // ones they want to include, hits Confirm, and the Mini App posts
  // back via `Telegram.WebApp.sendData(...)`. The orchestrator parses
  // that payload and creates the group-meal request directly — the
  // agent does not need to call request_meal_options_from_user.
  //
  // Strongly preferred over the text-list flow whenever the initiator
  // is on Telegram AND WEBAPP_URL is configured. Falls back to an
  // instructive error otherwise so the agent can switch to the text
  // flow.
  const showParticipantPicker = tool(
    async ({
      chatId,
      platform,
      title,
    }: {
      chatId: string;
      platform: "telegram" | "whatsapp";
      title?: string;
    }) => {
      if (platform !== "telegram") {
        return `This platform (${platform}) does not support Telegram Mini Apps. Fall back to list_available_users + request_meal_options_from_user.`;
      }
      if (!webAppUrl) {
        return `WEBAPP_URL is not configured — the Mini App picker is unavailable. Fall back to list_available_users + request_meal_options_from_user.`;
      }

      const url = new URL(webAppUrl);
      if (title) url.searchParams.set("title", title);

      const headline = title
        ? `Planning *${title}* — tap below to pick who to invite.`
        : `Tap below to pick who to invite to the meal.`;

      await messaging.sendMessage(
        {
          chatId,
          type: "text",
          text: headline,
          webAppButton: {
            text: "🍽 Pick participants",
            url: url.toString(),
          },
        },
        platform,
      );

      return `Participant picker sent to chat ${chatId}. The initiator will tap the button, select users, and confirm inside Telegram. No further action is needed from you — the orchestrator will create the group-meal request and DM invitees automatically. Tell the initiator 'I've opened a picker — select the people you want to invite and tap Confirm.'`;
    },
    {
      name: "show_participant_picker",
      description:
        "Open a Telegram Mini App inside the initiator's chat with a checklist of registered users. " +
        "The initiator picks participants and confirms; the bot then creates the group-meal request and DMs invitees automatically. " +
        "PREFER this over list_available_users + request_meal_options_from_user whenever the initiator is on Telegram. " +
        "Takes the initiator's chatId and platform (both available from the incoming message).",
      schema: z.object({
        chatId: z
          .string()
          .describe("Initiator's platform chat id (from the incoming message)."),
        platform: z
          .enum(["telegram", "whatsapp"])
          .describe("The platform the initiator is on."),
        title: z
          .string()
          .optional()
          .describe(
            "Optional default meal title (editable in the Mini App).",
          ),
      }),
    },
  );

  // ---- broadcast_plan_to_participants ----------------------------
  //
  // After the group has settled on a menu, push the final plan to every
  // participant so everyone sees the same thing. Delegates to the
  // orchestrator's own `broadcastPlanToParticipants` helper.
  const broadcastPlanToParticipants = tool(
    async ({ requestId, planText }: { requestId: number; planText: string }) => {
      if (!broadcastPlan) {
        return `broadcast_plan_to_participants is not wired — nothing sent.`;
      }
      const req = groupMeals.findRequest(requestId);
      if (!req) return `Request #${requestId} not found.`;
      const { delivered, failed, total } = await broadcastPlan(
        requestId,
        planText,
      );
      return `Plan broadcast for "${req.title}" (#${req.id}) — delivered ${delivered}/${total}${failed > 0 ? `, failed ${failed}` : ""}.`;
    },
    {
      name: "broadcast_plan_to_participants",
      description:
        "Send the finalized meal plan to ALL participants of a group-meal request (initiator + everyone who was invited). " +
        "Use this as the last step after the initiator approves the merged menu, so every person who agreed to plan together sees the final plan in their own chat.",
      schema: z.object({
        requestId: z
          .number()
          .describe("Internal id of the group meal request."),
        planText: z
          .string()
          .describe(
            "The final plan text to send — menu, timing, prep notes. Will be wrapped with a header naming the meal.",
          ),
      }),
    },
  );

  return {
    listAvailableUsers,
    requestMealOptionsFromUser,
    checkGroupMealStatus,
    showParticipantPicker,
    broadcastPlanToParticipants,
  };
}
