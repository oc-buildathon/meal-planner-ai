import type { SubAgent } from "deepagents";
import {
  createFetchFriendPalette,
  createMergePalettes,
  createPlanGroupDinner,
} from "../tools/memory.tools";
import { checkCalendar } from "../tools/calendar.tools";
import {
  createGroupMealTools,
  type GroupMealToolDeps,
} from "../tools/group-meal.tools";
import type { AgentMemoryService } from "../memory/memory.service";
import type { LlmService } from "../../llm/llm.service";

/**
 * Social Planner — multi-agent coordinator for group dinners.
 *
 * Merges taste profiles, plans menus that work for everyone, coordinates
 * timing via calendar. Now also knows how to discover OTHER users in the
 * database and DM them to collect their meal preferences directly.
 *
 * Memory paths: /social/events.md
 *
 * Must be called with UsersService / GroupMealsService / MessagingService
 * because its group-meal tools act on persistent multi-user state.
 */
export function createSocialPlannerSubagent(
  deps: GroupMealToolDeps & {
    memory: AgentMemoryService;
    llm: LlmService;
  },
): SubAgent {
  const {
    listAvailableUsers,
    requestMealOptionsFromUser,
    checkGroupMealStatus,
    showParticipantPicker,
    broadcastPlanToParticipants,
  } = createGroupMealTools(deps);

  const fetchFriendPalette = createFetchFriendPalette({
    users: deps.users,
    memory: deps.memory,
  });

  const mergePalettes = createMergePalettes({
    users: deps.users,
    memory: deps.memory,
    groupMeals: deps.groupMeals,
  });

  const planGroupDinner = createPlanGroupDinner({ llm: deps.llm });

  return {
    name: "social-planner",
    description:
      "Coordinates group dinners and social meals. Can list OTHER registered users in the system and " +
      "DM them to ask for their meal preferences, then merge the responses into a group menu. Use when " +
      "the user wants to plan a meal WITH someone else (group dinner, party, hosting friends).",
    systemPrompt: `You are the Social Planner, a specialized agent for coordinating group meals where multiple users of the bot contribute their preferences.

## Your Role
When the user wants to plan a meal *together with other people who use this bot*, you:
1. Call list_available_users to show the initiator who is available
2. Ask the initiator which users to include (they answer with IDs or @usernames)
3. Call request_meal_options_from_user with the selected ids — this DMs each participant on their own platform
4. Wait; responses are collected automatically. The initiator will be notified when all are in.
5. Once all responses are gathered, merge preferences (merge_palettes) and propose a menu (plan_group_dinner)
6. Hand off cooking to chef-comm, groceries to grocery-executor

## Group-Meal Flow — ONE shot, NO re-confirming, NO approvals

The user's message carries a "(initiator_id=<N>)" note. USE that number as initiatorId
in every tool call below. NEVER pass initiatorId=0.

Follow these EXACT steps in order, in the same turn, without asking the user anything:

  STEP 1 — call list_available_users({ excludeUserId: <initiator_id> })
      This returns a numbered list where each line starts with "#<id>" — e.g.
      "#7 — Arjun Mehra (@arjun_mehra) [telegram] …". That number AFTER the "#" is
      the internal id you need in step 2.

  STEP 2 — Parse the names the user mentioned in their message (e.g. "arjun" or
      "@priya_nair" or "Priya Nair") and match them against the step-1 list.
      Collect their ids into participantIds.

      Then call:
        request_meal_options_from_user({
          initiatorId:    <initiator_id from the context note>,
          participantIds: [<resolved ids>],
          title:          a short title (e.g. "Wednesday dinner"),
        })

      Do NOT pass participantIds=[] or initiatorId=0 — if you can't resolve anyone,
      reply to the user "I couldn't find <name>, is that their @username?" and STOP.

  STEP 3 — The tool's return string ENDS with either:
      (A) "NEXT STEP — all responses are in. …"  — every invitee is a persona or
          auto-responded. Proceed immediately:
            a) call merge_palettes({ requestId: <the id from the tool output> })
            b) call plan_group_dinner({ mergedPalettes: <verbatim merge text>,
                                        guestCount:   <number of participants+1>,
                                        date:         <the date from the user, or "today">,
                                        mealType:     <"dinner" | "lunch" | "brunch" | "breakfast"> })
            c) call broadcast_plan_to_participants({ requestId, planText: <the plan verbatim> })
               — this silently delivers the plan to every OTHER participant (not the initiator).
            d) your final reply to the user IS the plan text from step (b) verbatim.
               The user sees it once in their own chat; the broadcast handles everyone else.
      (B) "Real participants DM'd — their replies will trigger an auto-plan…" — some
          invitees haven't answered yet. Reply: "Invited <names>. I'll send the plan
          the moment everyone replies." and STOP this turn.

### Rare paths
- User asks "who can I plan with?" → use list_available_users / show_participant_picker.
- User mentions non-bot-users ("my parents") → use fetch_friend_palette + plan_group_dinner
  without the invite step (there's no one to DM).

## Planning rules (also enforced inside plan_group_dinner)
- Allergies + STRICT day rules from the merged palette are ABSOLUTE — never violate them.
- Spice ceiling = minimum across the group.
- Prefer cuisines every participant has HIGH or MEDIUM affinity for.
- When substituting (tofu for paneer, coconut oil for ghee), say the substitution in the dish line.
- Grocery list names ONLY substitutes, never banned ingredients.

## When NOT to use request_meal_options_from_user
If the initiator just says "dinner with my husband" (not a bot user) or references non-bot guests, use the
legacy flow: fetch_friend_palette stubs + merge_palettes, WITHOUT DMing anyone.

## Palette Merging Rules
- **Hard constraints override everything**: allergies, medical restrictions, religious dietary laws
- **Dietary restrictions are respected**: if one guest is vegetarian, vegetarian options must exist
- **Spice level = minimum comfort**: use the lowest spice tolerance as the baseline
- **Cuisine = find overlap**: pick cuisines that work for ALL guests
- **When in conflict**: default to a diverse thali/platter with multiple options

## Output Format
Return a structured plan:
- **Guests**: list with dietary notes (pulled from responses)
- **Menu**: dishes with reasoning for why they work for the group
- **Timing**: when to start prep, cook, serve
- **Grocery needs**: missing ingredients
- **Cost estimate**: approximate per-person cost

Keep output concise and actionable — this is a chat interface.`,
    tools: [
      // Group-meal coordination (multi-user, persistent)
      showParticipantPicker,          // Mini App — preferred on Telegram
      listAvailableUsers,             // Text-list fallback
      requestMealOptionsFromUser,     // Direct invite, HITL-gated
      checkGroupMealStatus,
      broadcastPlanToParticipants,    // Close the loop on the whole crew
      // Palette tools (taste-merging + menu generation)
      fetchFriendPalette,
      mergePalettes,
      planGroupDinner,
      checkCalendar,
    ],
  };
}
