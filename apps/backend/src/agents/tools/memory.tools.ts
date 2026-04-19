import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { UsersService, UserRow } from "../../database/users.service";
import type { AgentMemoryService } from "../memory/memory.service";

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

/**
 * `fetch_friend_palette` used to be a stub. It now actually reads the
 * DB + store, so the social-planner can look up any registered user
 * (including seeded demo personas Arjun / Priya) by `@username` or by
 * internal id and return their taste profile + diet plan verbatim.
 */
export function createFetchFriendPalette(deps: {
  users: UsersService;
  memory: AgentMemoryService;
}) {
  const { users, memory } = deps;

  return tool(
    async ({
      username,
      userId,
    }: {
      username?: string;
      userId?: number;
    }) => {
      let user: UserRow | null = null;
      if (userId) user = users.findById(userId);
      if (!user && username) user = users.findByUsername(username);

      if (!user) {
        return `Friend palette not found for ${userId ? "id=" + userId : "@" + username}. Ask the user to share the person's @username or use list_available_users to see who's registered.`;
      }

      const ns = AgentMemoryServiceUserNamespace(user.id);
      const taste = await memory.store.get(ns, "/taste/profile.md");
      const diet = await memory.store.get(ns, "/diet/active-plan.md");

      const name =
        [user.first_name, user.last_name].filter(Boolean).join(" ") ||
        user.username ||
        `User #${user.id}`;
      const handle = user.username ? ` (@${user.username})` : "";
      const personaTag = user.is_persona ? " [demo persona]" : "";

      const lines: string[] = [
        `## Palette for ${name}${handle}${personaTag}`,
        "",
      ];

      if (taste) {
        lines.push("### Taste Profile");
        lines.push(fileDataToString(taste.value));
        lines.push("");
      } else {
        lines.push("_Taste profile not yet recorded._", "");
      }

      if (diet) {
        lines.push("### Diet & Restrictions");
        lines.push(fileDataToString(diet.value));
        lines.push("");
      } else {
        lines.push("_Diet plan not yet recorded._", "");
      }

      return lines.join("\n");
    },
    {
      name: "fetch_friend_palette",
      description:
        "Fetch another registered user's taste profile + diet plan for group-meal planning. " +
        "Pass either `username` (e.g. 'arjun_mehra') or `userId` (internal id from list_available_users). " +
        "Returns their allergies, cuisine preferences, top dishes, dietary restrictions — everything needed " +
        "to plan a meal everyone will enjoy. Works for real users and seeded demo personas.",
      schema: z
        .object({
          username: z
            .string()
            .optional()
            .describe("The friend's @username (with or without leading @)"),
          userId: z
            .number()
            .optional()
            .describe("Internal user id (alternative to username)"),
        })
        .refine((v) => v.username || v.userId, {
          message: "either username or userId is required",
        }),
    },
  );
}

// Keep the standalone symbol around as a typed helper so the old
// import path still resolves for any callers that reference it, but
// it's deprecated in favour of `createFetchFriendPalette`.
export const fetchFriendPalette = undefined as never;

// ---- helpers -----------------------------------------------------

/** deepagents `FileData` stores content as an array of lines. */
function fileDataToString(fd: any): string {
  if (fd?.content && Array.isArray(fd.content)) return fd.content.join("\n");
  if (typeof fd?.content === "string") return fd.content;
  return JSON.stringify(fd ?? {}, null, 2);
}

/**
 * Imported dynamically to avoid a cyclic import (memory.service.ts
 * imports tools indirectly). We duplicate the namespace computation
 * since it's one line; keep in sync with AgentMemoryService.userNamespace.
 */
function AgentMemoryServiceUserNamespace(dbUserId: number | string): string[] {
  return ["mealprep-agent", "user", String(dbUserId)];
}

/**
 * `merge_palettes` — PROGRAMMATIC merge of N users' palettes.
 *
 * Resolves participants from any of `userIds`, `usernames`, or `requestId`
 * (which expands to initiator + all responded participants). For each
 * one, reads their /taste/profile.md + /diet/active-plan.md from the
 * store and surfaces:
 *
 *   - the *union* of hard restrictions (any allergy / STRICT / NEVER
 *     line across anyone in the group),
 *   - each participant's full palette,
 *   - their per-meal response if they replied to a group invite,
 *   - a concise planner hint (common cuisines / spice ceiling / day rules).
 *
 * The output is a single formatted string the agent passes straight into
 * `plan_group_dinner` — no more "analyze and merge" LLM hand-waving.
 */
export function createMergePalettes(deps: {
  users: UsersService;
  memory: AgentMemoryService;
  groupMeals?: { findRequest: (id: number) => any; getParticipants: (id: number) => any[] };
}) {
  const { users, memory, groupMeals } = deps;

  return tool(
    async ({
      userIds,
      usernames,
      requestId,
    }: {
      userIds?: number[];
      usernames?: string[];
      requestId?: number;
    }) => {
      // Resolve participant user rows
      type Participant = {
        user: UserRow;
        response?: string | null;
      };
      const collected: Participant[] = [];

      if (requestId && groupMeals) {
        const req = groupMeals.findRequest(requestId);
        if (!req) return `Request #${requestId} not found.`;
        const initiator = users.findById(req.initiator_id);
        if (initiator) collected.push({ user: initiator });
        for (const p of groupMeals.getParticipants(requestId)) {
          if (!p.user) continue;
          collected.push({
            user: p.user,
            response:
              p.participant?.status === "responded"
                ? p.participant.response_text
                : null,
          });
        }
      }
      if (userIds) {
        for (const id of userIds) {
          const u = users.findById(id);
          if (u && !collected.some((c) => c.user.id === u.id)) {
            collected.push({ user: u });
          }
        }
      }
      if (usernames) {
        for (const name of usernames) {
          const u = users.findByUsername(name);
          if (u && !collected.some((c) => c.user.id === u.id)) {
            collected.push({ user: u });
          }
        }
      }

      if (collected.length === 0) {
        return `No participants resolved. Provide userIds, usernames, or a requestId.`;
      }

      // Fetch profiles + diets in parallel
      const enriched = await Promise.all(
        collected.map(async (p) => {
          const ns = AgentMemoryServiceUserNamespace(p.user.id);
          const [taste, diet] = await Promise.all([
            memory.store.get(ns, "/taste/profile.md"),
            memory.store.get(ns, "/diet/active-plan.md"),
          ]);
          return {
            ...p,
            tasteText: fileDataToString(taste?.value) ?? "",
            dietText: fileDataToString(diet?.value) ?? "",
          };
        }),
      );

      // Union of hard restrictions per person
      const hardByPerson = enriched.map((p) => ({
        name: displayName(p.user),
        rules: extractHardRules(p.dietText + "\n" + p.tasteText),
      }));

      // Derived constraints
      const maxSpice = reduceSpice(
        enriched.map((p) => extractSpice(p.tasteText)),
      );
      const dayRules = enriched
        .flatMap((p) => extractNonVegDays(p.dietText))
        .filter((x, i, a) => a.indexOf(x) === i);
      const cuisineOverlap = computeCuisineOverlap(
        enriched.map((p) => extractCuisines(p.tasteText)),
      );

      // Build output
      const lines: string[] = [];
      lines.push(
        `# Group Preference Merge (${enriched.length} participant${enriched.length === 1 ? "" : "s"})`,
      );
      lines.push("");
      lines.push("## HARD RESTRICTIONS — union, respect ALL of these");
      for (const hp of hardByPerson) {
        if (hp.rules.length === 0) continue;
        lines.push(`- *${hp.name}*:`);
        for (const r of hp.rules.slice(0, 8)) {
          lines.push(`  • ${r}`);
        }
      }
      if (hardByPerson.every((h) => h.rules.length === 0)) {
        lines.push("- (none declared)");
      }

      lines.push("");
      lines.push("## Planner hints");
      lines.push(`- Spice ceiling: *${maxSpice}* (minimum across group)`);
      if (dayRules.length > 0) {
        lines.push(`- Day rules: ${dayRules.join(", ")}`);
      }
      if (cuisineOverlap.length > 0) {
        lines.push(`- Cuisines liked by all: ${cuisineOverlap.join(", ")}`);
      }

      lines.push("");
      lines.push("## Individual palettes");
      for (const p of enriched) {
        lines.push("");
        lines.push(`### ${displayName(p.user)} (@${p.user.username ?? "—"})${p.user.is_persona ? " [demo]" : ""}`);
        if (p.response) {
          lines.push(`*This-meal response*: ${p.response}`);
        }
        if (p.tasteText) {
          // Only pull highlight sections to keep the merge compact.
          const highlights = extractSections(p.tasteText, [
            "Top Dishes",
            "Cuisine Preferences",
            "Spice",
            "Favourite Flavour Notes",
          ]);
          if (highlights) {
            lines.push("");
            lines.push(highlights);
          }
        }
        if (p.dietText) {
          const dietHighlights = extractSections(p.dietText, [
            "Restrictions",
            "Allergies",
            "Substitutions",
            "Never",
            "NEVER serve",
          ]);
          if (dietHighlights) {
            lines.push("");
            lines.push(dietHighlights);
          }
        }
      }
      return lines.join("\n");
    },
    {
      name: "merge_palettes",
      description:
        "Read multiple users' stored taste profiles + diet plans and combine them into a single formatted summary with the UNION of hard restrictions (allergies, strict day rules) at the top. Pass the returned text to plan_group_dinner. Resolve participants by userIds (from list_available_users), usernames, OR a requestId from request_meal_options_from_user / show_participant_picker.",
      schema: z
        .object({
          userIds: z
            .array(z.number())
            .optional()
            .describe("Internal user ids from list_available_users."),
          usernames: z
            .array(z.string())
            .optional()
            .describe("@usernames (with or without leading @)"),
          requestId: z
            .number()
            .optional()
            .describe(
              "Group-meal request id — expands to initiator + responded participants.",
            ),
        })
        .refine(
          (v) =>
            (v.userIds && v.userIds.length > 0) ||
            (v.usernames && v.usernames.length > 0) ||
            typeof v.requestId === "number",
          { message: "provide userIds, usernames, or requestId" },
        ),
    },
  );
}

/**
 * `plan_group_dinner` — constraint-aware menu generation.
 *
 * Takes a merged palette (from `merge_palettes`) plus meal context and
 * runs an LLM with a strict system prompt that forbids violating any of
 * the hard rules surfaced by the merge. Returns plain text ready to
 * DM / broadcast.
 *
 * Kept as a factory because it needs LlmService.
 */
export function createPlanGroupDinner(deps: {
  llm: { complete: (prompt: string, system?: string) => Promise<string> };
}) {
  return tool(
    async ({
      mergedPalettes,
      guestCount,
      date,
      mealType,
      extraNotes,
    }: {
      mergedPalettes: string;
      guestCount: number;
      date?: string;
      mealType: "lunch" | "dinner" | "brunch" | "party" | "breakfast";
      extraNotes?: string;
    }) => {
      const system =
        `You are a meal-planning specialist. Generate a concrete group menu.

HARD RULES (absolute — violating any is a failed plan):

1. ALLERGIES / "NEVER / CRITICAL" items: read the "HARD RESTRICTIONS" block in the merged palette line-by-line and treat every entry as forbidden for EVERYONE in the group. Examples:
   - "no legumes" → NO dal, rajma, chhole, moong, masoor, urad, kidney beans, lentils, peanuts. Khichdi and pesarattu also FORBIDDEN.
   - "no dairy"   → NO milk, cream, butter, ghee, paneer, dahi, cheese, malai. Substitute:
       butter/ghee → coconut oil
       cream       → coconut milk + cashew paste (or coconut cream)
       dahi        → coconut yogurt
       milk (tea)  → oat milk
       milk (cook) → coconut milk
       paneer      → tofu
     Coconut yogurt IS a safe substitute (not real dairy). Name the substitution explicitly in the menu.

2. DAY RULES (veto): the merged palette lists "Day rules: no non-veg on <days>" under Planner hints. If the requested date falls on such a day for ANY participant, the menu MUST be 100% vegetarian — NO chicken, mutton, fish, eggs, meat, or seafood anywhere. This rule overrides any cuisine or favourite-dish preference.

3. SPICE: stay at or below the stated ceiling.

4. OVERLAP: prefer cuisines listed under "Cuisines liked by all". Avoid suggestions nobody's profile mentions liking.

Before finalising, self-check: for each dish, confirm it violates none of the HARD RESTRICTIONS and passes the DAY rule. If anything fails, swap it.

OUTPUT (WhatsApp-compatible — ONLY these markers):
  *bold*, _italic_, bullets as "• ", NO # headers, NO **double-bold**, NO markdown links, NO code fences.

Structure:
*Menu for <title>*
  • Dish 1 — one-line reason / substitution used (e.g. "Chilli 'Paneer' (made with tofu)")
  • Dish 2 — …

*Prep timeline*: start at HH:MM, serve by HH:MM.
*Grocery needs*: comma-separated list. ONLY list the SUBSTITUTE ingredient — e.g. "tofu" (never "paneer"), "coconut oil" (never "ghee"), "coconut yogurt" (never "dahi"). A banned ingredient must NEVER appear in this list.
*Why this works*: 1–2 sentences citing the restrictions respected.

Keep it tight — 14 lines max.`;

      const userPrompt =
        `Group size: ${guestCount}\n` +
        (date ? `Date: ${date}\n` : "") +
        `Meal type: ${mealType}\n` +
        (extraNotes ? `Host notes: ${extraNotes}\n` : "") +
        `\nMerged palette:\n${mergedPalettes}`;

      try {
        const reply = await deps.llm.complete(userPrompt, system);
        const trimmed = (reply ?? "").trim();
        if (trimmed) return trimmed;
      } catch (e) {
        return `Plan generation failed: ${e}. Please try again.`;
      }
      return `Planner returned empty — not enough constraint info, try again with more context.`;
    },
    {
      name: "plan_group_dinner",
      description:
        "Generate a concrete group meal menu that respects the UNION of hard restrictions from a merge_palettes result. Input the full merged palette text (verbatim from merge_palettes) plus the guestCount, date, and mealType. Returns WhatsApp-formatted plan text suitable to broadcast_plan_to_participants.",
      schema: z.object({
        mergedPalettes: z
          .string()
          .describe(
            "The full text output from merge_palettes — pass it verbatim, do not summarize.",
          ),
        guestCount: z
          .number()
          .int()
          .min(1)
          .describe("Total number of people eating."),
        date: z
          .string()
          .optional()
          .describe("Date of the meal (YYYY-MM-DD or 'today'/'Saturday')."),
        mealType: z
          .enum(["lunch", "dinner", "brunch", "party", "breakfast"])
          .describe("Type of meal."),
        extraNotes: z
          .string()
          .optional()
          .describe(
            "Any extra host notes (budget, time constraints, cuisine vibe requested).",
          ),
      }),
    },
  );
}

// ---- extraction helpers -----------------------------------------

function displayName(u: UserRow): string {
  return (
    [u.first_name, u.last_name].filter(Boolean).join(" ").trim() ||
    u.username ||
    `User #${u.id}`
  );
}

/** Keywords that mark a line as a hard restriction header. */
const RULE_HEADER_RX =
  /\b(CRITICAL|NEVER\s+serve|NEVER\b|STRICT\s+rule|ALLERG(?:Y|IC|IES)|no[\s-]+dairy|no[\s-]+legume|no[\s-]+non[\s-]?veg)\b/i;

/**
 * Context-only prefixes that are NOT rules — skip them even if they live
 * near a rule section header ("Type:", "Pattern:", etc).
 */
const CONTEXT_PREFIX_RX =
  /^(Type|Pattern|Cheat\s+day|Medical|Religious|Weekly\s+pattern|Occasion)\s*:/i;

/**
 * Pull lines that clearly denote a hard rule.
 *
 *  - BLOCK START:  A section-like introducer — "Allergies", "Restrictions",
 *                  "NEVER serve", or any line containing "CRITICAL" /
 *                  "STRICT rule". This opens a "capture-until-blank" block
 *                  for the following indented bullets (capped at 5 to keep
 *                  the merge compact).
 *  - SELF-RULE:    A bullet that on its own clearly mentions a forbidden
 *                  class ("no dairy", "no legumes", "no non-veg on X") —
 *                  captured as a one-off, does NOT open a block so we
 *                  don't sweep in neighbouring preference bullets.
 *
 * Context prefixes like "Type:", "Pattern:", "Cheat day:", "Medical:",
 * "Religious:" are filtered out whether they're at the top level or under
 * a captured block, and whether or not they're wrapped in `**`.
 */
function extractHardRules(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  let captureUntilBlank = false;
  let capturedInBlock = 0;

  const stripLeadBoldAndBullet = (s: string): string =>
    s.replace(/^[-*•\s]+/, "").replace(/^\*+/, "");

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      captureUntilBlank = false;
      capturedInBlock = 0;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      captureUntilBlank = false;
      capturedInBlock = 0;
      continue;
    }
    // Skip context prefixes — strip any bold markers before matching.
    const unwrapped = line.replace(/^[*_]+/, "").replace(/^[-*•\s]+/, "");
    if (CONTEXT_PREFIX_RX.test(unwrapped)) {
      captureUntilBlank = false;
      continue;
    }

    const isBullet = /^[-*•]\s+/.test(line);

    // BLOCK START — only markdown headers ("## Restrictions") or lines
    // that look like a section introducer (start with "Allergies",
    // "Restrictions", or contain CRITICAL/STRICT-rule).
    const isBlockStart =
      /^\**\s*(Allerg|Restrictions?|NEVER\s+serve)\b/i.test(unwrapped) ||
      /CRITICAL|STRICT\s+rule/.test(line);

    if (isBlockStart) {
      const clean = cleanRule(line);
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        out.push(clean);
      }
      captureUntilBlank = true;
      capturedInBlock = 0;
      continue;
    }

    // SELF-RULE — bullet with an unambiguous "no X" / allergy mention.
    if (isBullet && RULE_HEADER_RX.test(line)) {
      const clean = cleanRule(line);
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        out.push(clean);
      }
      continue;
    }

    // INDENTED BULLETS under an open block — capped at 5 per block.
    if (captureUntilBlank && isBullet && capturedInBlock < 5) {
      const stripped = stripLeadBoldAndBullet(line);
      if (CONTEXT_PREFIX_RX.test(stripped)) continue;
      const clean = cleanRule(stripped);
      if (clean && clean.length < 240 && !seen.has(clean)) {
        seen.add(clean);
        out.push(clean);
        capturedInBlock++;
      }
    }

    if (out.length > 12) break;
  }
  return out;
}

function cleanRule(s: string): string {
  return s
    .replace(/^[#*\-•\s>]+/, "")
    .replace(/\*+/g, "")
    .replace(/\s+$/, "")
    .trim();
}

/** Grab named ## / ### sections out of a markdown body. */
function extractSections(text: string, names: string[]): string {
  if (!text) return "";
  const lines = text.split("\n");
  const buf: string[] = [];
  let inSection = false;
  let depth = 0;
  for (const line of lines) {
    const header = line.match(/^(#{2,4})\s+(.*)$/);
    if (header) {
      const [, hashes, title] = header;
      const d = hashes.length;
      const hit = names.some((n) =>
        title.toLowerCase().includes(n.toLowerCase()),
      );
      if (hit) {
        inSection = true;
        depth = d;
        buf.push(line);
        continue;
      }
      if (inSection && d <= depth) {
        inSection = false;
      }
    }
    if (inSection) buf.push(line);
  }
  return buf.join("\n").trim();
}

/** Return a spice-tolerance keyword from the taste profile (best-effort). */
function extractSpice(text: string): string {
  const m = text.match(/Spice[^\n]*\n([^\n]+)/i);
  if (!m) return "medium";
  const line = m[1].toLowerCase();
  if (/very\s*high|high-/.test(line)) return "medium-high";
  if (/medium-high|med-high|medium\s*\/?\s*high/.test(line)) return "medium-high";
  if (/high/.test(line) && !/medium/.test(line)) return "high";
  if (/medium/.test(line)) return "medium";
  if (/low/.test(line)) return "low";
  return "medium";
}

/** Pick the LOWEST (most restrictive) spice level across users. */
function reduceSpice(levels: string[]): string {
  const order: Record<string, number> = {
    low: 0,
    medium: 1,
    "medium-high": 2,
    high: 3,
  };
  let best = 3;
  for (const l of levels) {
    const v = order[l as keyof typeof order] ?? 1;
    if (v < best) best = v;
  }
  return (Object.keys(order) as Array<keyof typeof order>).find(
    (k) => order[k] === best,
  )!;
}

/**
 * Extract days on which a participant does NOT eat non-veg. Handles
 * three common formats seen in persona diet files:
 *   - Inline:        "no non-veg on Monday, Saturday"
 *   - Multi-line:    header ("no non-veg on:") then indented bullets
 *                    listing day names on the next 1-6 lines.
 *   - YAML-ish:      "no_non_veg_on: [Monday, Saturday]"
 */
function extractNonVegDays(text: string): string[] {
  if (!text) return [];
  const days = new Set<string>();
  const DAY_RX = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/g;

  // 1) Inline — "no non-veg on Monday[, Saturday]"
  const inlineRx =
    /no\s+non[\s-]?veg\s+on[^\n]*?(\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b[^\n.]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = inlineRx.exec(text)) !== null) {
    for (const d of m[1].match(DAY_RX) ?? []) days.add(d);
  }

  // 2) Multi-line — a line mentioning "no non-veg" followed by bullets
  //    with day names in the next few lines.
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/no\s+non[\s-]?veg/i.test(lines[i])) {
      for (let j = i; j < Math.min(i + 6, lines.length); j++) {
        for (const d of lines[j].match(DAY_RX) ?? []) days.add(d);
      }
    }
  }

  // 3) YAML-ish inline list
  const arr = text.match(/no_non_veg_on[:\s]*\[([^\]]+)\]/i);
  if (arr) {
    for (const d of arr[1].match(DAY_RX) ?? []) days.add(d);
  }

  return days.size > 0 ? [`no non-veg on ${Array.from(days).join(", ")}`] : [];
}

/** Parse "**Cuisine**: HIGH/MEDIUM" style lines into a map. */
function extractCuisines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const section = extractSections(text, ["Cuisine Preferences", "Cuisine"]);
  if (!section) return out;
  const rx = /([A-Za-z][A-Za-z \-\/]+?):\s*(VERY HIGH|HIGH|MEDIUM|LOW)/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(section)) !== null) {
    const name = m[1].replace(/^\*+|\*+$/g, "").replace(/^- /, "").trim();
    const level = m[2].toUpperCase();
    if (name.length < 40) out[name.toLowerCase()] = level;
  }
  return out;
}

/** Cuisines with at least MEDIUM affinity for everyone. */
function computeCuisineOverlap(
  maps: Array<Record<string, string>>,
): string[] {
  if (maps.length === 0) return [];
  const rank: Record<string, number> = {
    "VERY HIGH": 3,
    HIGH: 2,
    MEDIUM: 1,
    LOW: 0,
  };
  const first = maps[0];
  const out: string[] = [];
  for (const c of Object.keys(first)) {
    const allOk = maps.every((m) => (rank[m[c] ?? "LOW"] ?? 0) >= 1);
    if (allOk) out.push(c);
  }
  return out.slice(0, 8);
}
