import { tool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * Google Calendar tools — stubs for Phase 6.
 * Will integrate with Google Calendar API v3 via OAuth2.
 */

export const checkCalendar = tool(
  async ({ date, timeRange }: { date: string; timeRange?: string }) => {
    // Phase 6: Will use Google Calendar API v3
    return JSON.stringify({
      status: "stub",
      date,
      timeRange,
      message: `Calendar integration coming in Phase 6. For ${date}${timeRange ? ` (${timeRange})` : ""}, assume no conflicts. Ask the user about their schedule directly.`,
      events: [],
    });
  },
  {
    name: "check_calendar",
    description:
      "Check Google Calendar for events on a specific date. Used to plan meals around schedules — dinner parties, travel, fasting days, etc.",
    schema: z.object({
      date: z.string().describe("Date to check (YYYY-MM-DD)"),
      timeRange: z
        .string()
        .optional()
        .describe("Time range to check (e.g. 'evening', '18:00-21:00')"),
    }),
  },
);

export const getDietPlan = tool(
  async ({ userId }: { userId?: string }) => {
    // Phase 5: Will read from /diet/active-plan.md via the agent's filesystem
    return JSON.stringify({
      status: "stub",
      message:
        "Diet plan tracking coming in Phase 5. For now, ask the user about their dietary restrictions and preferences directly. Store any info they share in /diet/active-plan.md.",
    });
  },
  {
    name: "get_diet_plan",
    description:
      "Retrieve the user's active diet plan (keto, vegan, intermittent fasting, custom macros, etc.) including calorie targets and restrictions.",
    schema: z.object({
      userId: z
        .string()
        .optional()
        .describe("User ID (defaults to current user)"),
    }),
  },
);

export const updateDiet = tool(
  async ({
    planType,
    details,
    restrictions,
  }: {
    planType: string;
    details: string;
    restrictions?: string[];
  }) => {
    return `Diet plan update requested. Type: ${planType}. Details: ${details}. Restrictions: ${(restrictions ?? []).join(", ")}. Write this to /diet/active-plan.md. THIS REQUIRES USER CONFIRMATION before applying.`;
  },
  {
    name: "update_diet",
    description:
      "Update the user's active diet plan. THIS REQUIRES USER CONFIRMATION. Changes affect all future meal suggestions.",
    schema: z.object({
      planType: z
        .string()
        .describe(
          "Type of diet (e.g. 'keto', 'vegan', 'intermittent_fasting', 'no_restriction', 'custom')",
        ),
      details: z
        .string()
        .describe(
          "Full details of the diet plan (calorie targets, macro splits, meal timing, etc.)",
        ),
      restrictions: z
        .array(z.string())
        .optional()
        .describe(
          "List of hard restrictions (allergies, medical conditions, religious)",
        ),
    }),
  },
);
