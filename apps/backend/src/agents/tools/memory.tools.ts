import { tool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * Tools for reading and updating user taste/diet/social memory.
 * These operate on the agent's filesystem (backed by StoreBackend),
 * so changes persist across conversations.
 *
 * Note: The deepagents framework provides built-in `edit_file` and `read_file`
 * tools for general file operations. These tools provide higher-level,
 * domain-specific abstractions on top of that.
 */

export const updateTasteMemory = tool(
  async ({
    section,
    content,
  }: {
    section: string;
    content: string;
  }) => {
    // This tool is a semantic hint for the agent — actual file writes go through
    // the deepagents built-in edit_file tool. This provides a structured interface
    // that the orchestrator can log and audit.
    return `Taste memory updated. Section: ${section}. Write the following to /taste/profile.md under "## ${section}":\n${content}`;
  },
  {
    name: "update_taste_memory",
    description:
      "Update the user's taste profile memory. Records food preferences, spice tolerance, cuisine likes/dislikes, and feedback from past meals. Use this after analyzing food images, voice feedback, or recipe shares.",
    schema: z.object({
      section: z
        .enum([
          "cuisine_preferences",
          "spice_tolerance",
          "ingredient_likes",
          "ingredient_dislikes",
          "recipe_feedback",
          "general_notes",
        ])
        .describe("Which section of the taste profile to update"),
      content: z
        .string()
        .describe("The content to write to this section (markdown)"),
    }),
  },
);

export const fetchFriendPalette = tool(
  async ({ username }: { username: string }) => {
    // Stub — will query the palette registry (PostgreSQL) in Phase 6
    return JSON.stringify({
      username,
      status: "not_found",
      message: `Friend palette for @${username} not yet available. Palette registry coming in Phase 6.`,
    });
  },
  {
    name: "fetch_friend_palette",
    description:
      "Fetch a friend's public taste profile (Agent Palette) for group dinner planning. Returns their cuisine preferences, dietary restrictions, and spice tolerance.",
    schema: z.object({
      username: z
        .string()
        .describe("The friend's @username to look up"),
    }),
  },
);

export const mergePalettes = tool(
  async ({
    palettes,
  }: {
    palettes: Array<{ username: string; preferences: string }>;
  }) => {
    const names = palettes.map((p) => `@${p.username}`).join(", ");
    return `Palette merge requested for ${names}. Analyze all preferences and find the best overlap. Consider dietary restrictions as hard constraints and cuisine/spice preferences as soft constraints. Return a merged menu recommendation.`;
  },
  {
    name: "merge_palettes",
    description:
      "Merge multiple users' taste profiles (Agent Palettes) to find the optimal group dinner menu. Hard constraints (allergies, dietary restrictions) override soft preferences (cuisine types, spice levels).",
    schema: z.object({
      palettes: z
        .array(
          z.object({
            username: z.string(),
            preferences: z.string().describe("Summary of this user's taste profile"),
          }),
        )
        .describe("List of user palettes to merge"),
    }),
  },
);

export const planGroupDinner = tool(
  async ({
    guestCount,
    mergedPreferences,
    date,
    mealType,
  }: {
    guestCount: number;
    mergedPreferences: string;
    date: string;
    mealType: string;
  }) => {
    return `Group dinner plan requested for ${guestCount} guests on ${date} (${mealType}). Merged preferences: ${mergedPreferences}. Generate a complete menu with recipes, quantities scaled for ${guestCount}, and a grocery list.`;
  },
  {
    name: "plan_group_dinner",
    description:
      "Create a complete group dinner plan including menu, recipes, and grocery list, based on merged taste preferences of all guests.",
    schema: z.object({
      guestCount: z.number().describe("Total number of people eating"),
      mergedPreferences: z
        .string()
        .describe("Merged taste preferences from palette merge"),
      date: z.string().describe("Date of the dinner (YYYY-MM-DD)"),
      mealType: z
        .enum(["lunch", "dinner", "brunch", "party"])
        .describe("Type of meal"),
    }),
  },
);
