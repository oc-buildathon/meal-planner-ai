import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
} from "@nestjs/common";
import { MemorySaver, type BaseStore } from "@langchain/langgraph";
import type { FileData } from "deepagents";
import { DatabaseService } from "../../database/database.service";
import { SqliteStore } from "../../database/sqlite-store";

/** Create a FileData object for seeding into the store. */
function createFileData(content: string): FileData {
  const now = new Date().toISOString();
  return {
    content: content.split("\n"),
    created_at: now,
    modified_at: now,
  };
}

/**
 * AgentMemoryService — owns the persistent `BaseStore` and thread-state
 * checkpointer used by every per-user deep agent.
 *
 * Architecture:
 *   - The store is a {@link SqliteStore} backed by the same SQLite file
 *     used for users / message log. This means taste profiles, diet
 *     plans, AGENT.md, etc. survive process restarts.
 *   - Namespaces split into TWO planes:
 *       (a) GLOBAL skills, shared across all users:
 *             ["mealprep-agent", "skills"]
 *       (b) PER-USER memory, isolated per Telegram / WhatsApp user:
 *             ["mealprep-agent", "user", "<dbUserId>"]
 *   - Global skills are seeded once at startup.
 *     Per-user files are seeded the first time a user talks to the bot.
 *   - The checkpointer remains in-process (`MemorySaver`). Per-user
 *     thread_ids are already persisted via `users.thread_id` in SQLite,
 *     so if we ever swap in a SQL-backed checkpointer conversations
 *     would resume across restarts too. Currently, only long-term
 *     memory (taste / diet / AGENT.md) persists — recent chat turns
 *     reset on restart. That's an acceptable trade and the user's
 *     learned preferences are the expensive thing to keep.
 */
@Injectable()
export class AgentMemoryService implements OnModuleInit {
  private readonly logger = new Logger(AgentMemoryService.name);

  /** Shared persistent store for all agent memory + skills. */
  store!: BaseStore;

  /** In-process checkpointer for per-thread graph state. */
  readonly checkpointer = new MemorySaver();

  /** Namespace for GLOBAL skills (shared across users). */
  static readonly SKILLS_NAMESPACE = ["mealprep-agent", "skills"];

  /** Namespace prefix for PER-USER memory trees. */
  static readonly USER_NAMESPACE_PREFIX = ["mealprep-agent", "user"];

  /** Legacy alias — kept for any callers that still reference the old
   *  shared namespace during the migration. New code should pick either
   *  {@link SKILLS_NAMESPACE} or {@link userNamespace}. */
  static readonly AGENT_NAMESPACE = ["mealprep-agent"];

  /** Remember which user namespaces we've already seeded this process. */
  private readonly seededUsers = new Set<string>();

  constructor(
    @Inject(DatabaseService) private readonly dbs: DatabaseService,
  ) {}

  async onModuleInit() {
    this.store = new SqliteStore(this.dbs.db);
    await this.seedGlobalSkills();
    this.logger.log(
      "Agent memory ready (SqliteStore — persistent across restarts). " +
        "Per-user memory seeded lazily on first message.",
    );
  }

  /** Build the user-scoped namespace used for `/memories/`, `/taste/`, etc. */
  static userNamespace(dbUserId: number | string): string[] {
    return [...AgentMemoryService.USER_NAMESPACE_PREFIX, String(dbUserId)];
  }

  /**
   * Seed this user's initial memory files (AGENT.md, empty taste profile,
   * etc.) exactly once per user per process. Called from the orchestrator
   * when an agent is instantiated for a user for the first time.
   *
   * Idempotent: checks whether `/memories/AGENT.md` already exists for
   * the user before writing, so restarts with pre-existing data do not
   * clobber learned preferences.
   */
  async ensureUserMemorySeeded(dbUserId: number | string): Promise<void> {
    const userKey = String(dbUserId);
    if (this.seededUsers.has(userKey)) return;

    const ns = AgentMemoryService.userNamespace(dbUserId);

    // Fast path: already seeded in a previous process run.
    const existing = await this.store.get(ns, "/memories/AGENT.md");
    if (existing) {
      this.seededUsers.add(userKey);
      return;
    }

    await this.store.put(
      ns,
      "/memories/AGENT.md",
      createFileData(
        [
          "# MealPrep Agent Memory",
          "",
          "## Identity",
          "- I am MealPrep, an AI meal planning assistant",
          "- I help users plan meals, communicate with their cook, and order groceries",
          "- Primary interface: WhatsApp. Secondary: Telegram",
          "- I communicate in the same language as the user (Hindi, English, Hinglish)",
          "",
          "## Learned Preferences",
          "- (none yet — will be updated as I learn from conversations)",
          "",
          "## Response Style",
          "- Keep responses concise and actionable",
          "- Use WhatsApp-friendly formatting (*bold*, numbered lists)",
          "- Always confirm before sending messages to the chef or placing orders",
          "",
        ].join("\n"),
      ),
    );

    await this.store.put(
      ns,
      "/taste/profile.md",
      createFileData(
        [
          "# Taste Profile",
          "",
          "## Cuisine Preferences",
          "- (not yet recorded)",
          "",
          "## Spice Tolerance",
          "- (not yet recorded)",
          "",
          "## Ingredient Likes",
          "- (not yet recorded)",
          "",
          "## Ingredient Dislikes",
          "- (not yet recorded)",
          "",
          "## General Notes",
          "- (not yet recorded)",
          "",
        ].join("\n"),
      ),
    );

    await this.store.put(
      ns,
      "/taste/feedback-log.md",
      createFileData(
        [
          "# Meal Feedback Log",
          "",
          "<!-- Entries added by taste-learner -->",
          "",
        ].join("\n"),
      ),
    );

    await this.store.put(
      ns,
      "/diet/active-plan.md",
      createFileData(
        [
          "# Active Diet Plan",
          "",
          "## Current Plan",
          "- Type: No specific diet (default)",
          "- Calorie target: Not set",
          "",
          "## Restrictions",
          "- Allergies: (none recorded)",
          "- Medical: (none recorded)",
          "- Religious: (none recorded)",
          "",
        ].join("\n"),
      ),
    );

    await this.store.put(
      ns,
      "/chat-history/chef-log.md",
      createFileData(
        [
          "# Chef Communication Log",
          "",
          "<!-- Entries added by chef-comm -->",
          "",
        ].join("\n"),
      ),
    );

    await this.store.put(
      ns,
      "/orders/history.md",
      createFileData(
        [
          "# Grocery Order History",
          "",
          "<!-- Entries added by grocery-executor -->",
          "",
        ].join("\n"),
      ),
    );

    await this.store.put(
      ns,
      "/social/events.md",
      createFileData(
        [
          "# Social Events & Group Dinners",
          "",
          "<!-- Entries added by social-planner -->",
          "",
        ].join("\n"),
      ),
    );

    this.seededUsers.add(userKey);
    this.logger.log(`Seeded per-user memory for user=${userKey}`);
  }

  // ----------------------------------------------------------------
  // Global skills — seeded ONCE, shared across all users.
  // ----------------------------------------------------------------

  private async seedGlobalSkills() {
    const ns = AgentMemoryService.SKILLS_NAMESPACE;

    // Idempotent: skip if already seeded in a previous run.
    const marker = await this.store.get(ns, "/skills/indian-cuisine/SKILL.md");
    if (marker) return;

    await this.store.put(
      ns,
      "/skills/indian-cuisine/SKILL.md",
      createFileData(
        [
          "---",
          "name: indian-cuisine",
          "description: Expert knowledge of Indian cuisine including North Indian, South Indian, Bengali, Gujarati, and street food. Use for meal suggestions, recipe generation, ingredient substitutions, and regional cuisine recommendations.",
          "---",
          "",
          "# Indian Cuisine Expert",
          "",
          "## Overview",
          "Use this skill when the user asks about Indian food, needs recipe suggestions, or wants cuisine-specific meal planning.",
          "",
          "## Cuisine Regions",
          "- **North Indian**: Rich gravies, tandoor, paneer, dal makhani, butter chicken, naan, paratha",
          "- **South Indian**: Rice-based, dosa, idli, sambar, rasam, coconut-heavy, appam",
          "- **Bengali**: Fish-based, mustard oil, sweets (rasgulla, sandesh), shorshe ilish",
          "- **Gujarati**: Sweet-savory balance, thepla, dhokla, undhiyu, mostly vegetarian",
          "- **Rajasthani**: Dal-baati-churma, gatte ki sabzi, ker sangri, desert cuisine",
          "- **Mughlai**: Biryani, korma, kebabs, rich cream-based",
          "- **Street Food**: Chaat, pani puri, vada pav, chole bhature, pav bhaji",
          "",
          "## Meal Planning Guidelines",
          "- Standard Indian meal: 1 dal/curry + 1 sabzi + roti/rice + salad/raita",
          "- Lunch is typically the heaviest meal",
          "- Dinner should be lighter (dal-chawal, khichdi, roti-sabzi)",
          "- Breakfast varies: poha, upma, paratha, idli, dosa",
          "- Always consider seasonal vegetables",
          "",
          "## Common Substitutions",
          "- Paneer <-> Tofu (for vegan)",
          "- Cream <-> Cashew paste (for dairy-free)",
          "- Ghee <-> Oil (for lighter version)",
          "- White rice <-> Brown rice / Quinoa (for health-conscious)",
          "- Sugar <-> Jaggery (traditional sweetener)",
          "",
          "## Festival & Seasonal Awareness",
          "- **Navratri**: Fasting menu (sabudana, kuttu, fruits, no onion/garlic)",
          "- **Diwali**: Sweets (ladoo, barfi, gulab jamun), snacks (namkeen, chakli)",
          "- **Monsoon**: Comfort food (pakoras, chai, bhajiya, hot soups)",
          "- **Summer**: Cooling (chaas, aam panna, light meals, salads)",
          "- **Winter**: Rich (sarson ka saag, makki ki roti, gajar halwa)",
          "",
        ].join("\n"),
      ),
    );

    await this.store.put(
      ns,
      "/skills/meal-planning/SKILL.md",
      createFileData(
        [
          "---",
          "name: meal-planning",
          "description: Structured meal planning workflow for daily, weekly, and event-based meal plans. Use when the user asks to plan meals, create a menu, or organize their cooking schedule.",
          "---",
          "",
          "# Meal Planning Workflow",
          "",
          "## Overview",
          "Use this skill for any meal planning request. Follow the structured workflow below.",
          "",
          "## Planning Steps",
          "",
          "### 1. Gather Context",
          "Before suggesting meals, check:",
          "- Read /taste/profile.md for food preferences",
          "- Read /diet/active-plan.md for dietary constraints",
          "- Ask about number of people eating",
          "- Ask about any specific cravings or restrictions for this meal",
          "- Check if there are guests (triggers social-planner)",
          "",
          "### 2. Generate Options",
          "- Suggest 2-3 meal options that match the taste profile and diet",
          "- For each option, provide: dish name, brief description, estimated prep time",
          "- Highlight any ingredients that might need ordering",
          "",
          "### 3. Confirm Selection",
          "- Let the user pick or modify the suggestion",
          "- Confirm the final menu",
          "",
          "### 4. Execute",
          "- Delegate to chef-comm subagent for cooking instructions",
          "- Delegate to grocery-executor subagent for missing ingredients",
          "- Set reminders for meal timing",
          "",
          "## Weekly Planning Template",
          "When planning for a full week:",
          "- Balance cuisines across the week (don't repeat the same cuisine 2 days in a row)",
          "- Reuse ingredients across meals to minimize waste and grocery cost",
          "- Include at least 1 light meal per day",
          "- Account for leftover potential (cook extra dal on Mon, use for Wed lunch)",
          "",
          "## Budget Awareness",
          "- Track estimated cost per meal",
          "- Flag when weekly grocery total exceeds any stated budget",
          "- Suggest budget-friendly alternatives when needed",
          "",
        ].join("\n"),
      ),
    );

    await this.store.put(
      ns,
      "/skills/chef-communication/SKILL.md",
      createFileData(
        [
          "---",
          "name: chef-communication",
          "description: Guidelines for communicating with the cook/chef via WhatsApp or Telegram. Use when sending meal plans, instructions, or queries to the chef.",
          "---",
          "",
          "# Chef Communication Guidelines",
          "",
          "## Overview",
          "The chef is typically a home cook. Communication should be clear, respectful, and in a language they understand (often Hindi).",
          "",
          "## Message Format",
          "When sending cooking instructions to the chef:",
          "",
          "### Simple Meal",
          "```",
          "Aaj dinner mein [dish] banana hai, [N] logo ke liye",
          "",
          "Ingredients: [list]",
          "Steps: [numbered]",
          "Time: [when to start]",
          "```",
          "",
          "### Detailed Recipe",
          "Use the format_recipe_instructions tool to structure the recipe properly.",
          "",
          "## Rules",
          "- ALWAYS get user approval before sending any message to the chef",
          "- Send messages at appropriate times (not too early/late)",
          "- Keep instructions simple and actionable",
          "- Include quantities for all ingredients",
          "- Mention serving count",
          "- Ask for confirmation after sending instructions",
          "",
        ].join("\n"),
      ),
    );

    this.logger.log("Global skills seeded");
  }
}
