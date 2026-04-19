/**
 * Seed demo personas (Arjun Mehra, Priya Nair) into the database +
 * per-user agent memory store.
 *
 * Run with:
 *   bun run seed:personas
 *
 * Idempotent: running multiple times is safe. Upserts the users and
 * overwrites their memory files with the latest persona-data.ts content.
 */

import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";

// Make sure the messaging adapters don't start long-poll loops while we
// run a one-shot script. Must be set BEFORE AppModule is imported.
process.env.TELEGRAM_ENABLED = "false";
process.env.WHATSAPP_ENABLED = "false";

// eslint-disable-next-line import/first
import { AppModule } from "../app.module";
// eslint-disable-next-line import/first
import { UsersService } from "../database/users.service";
// eslint-disable-next-line import/first
import { AgentMemoryService } from "../agents/memory/memory.service";
// eslint-disable-next-line import/first
import { PERSONA_SEEDS } from "./persona-data";

function createFileData(text: string) {
  const now = new Date().toISOString();
  return {
    content: text.split("\n"),
    created_at: now,
    modified_at: now,
  };
}

async function main() {
  const logger = new Logger("seed:personas");

  // `createApplicationContext` skips the HTTP server but still runs
  // OnModuleInit hooks — which is what we need (DB migrations, SqliteStore).
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["log", "warn", "error"],
  });

  try {
    const users = app.get(UsersService);
    const memory = app.get(AgentMemoryService);

    for (const seed of PERSONA_SEEDS) {
      const user = users.upsert({
        platform: seed.platform,
        platformUserId: seed.platformUserId,
        chatId: seed.platformUserId, // no real chat, reuse stable id
        username: seed.username,
        firstName: seed.firstName,
        lastName: seed.lastName,
        languageCode: seed.languageCode,
        isBot: false,
        isPersona: true,
      });

      const ns = AgentMemoryService.userNamespace(user.id);

      for (const [path, content] of Object.entries(seed.memory)) {
        await memory.store.put(ns, path, createFileData(content));
      }

      logger.log(
        `Persona seeded: #${user.id} ${seed.firstName} ${seed.lastName} ` +
          `(@${seed.username}) — ${Object.keys(seed.memory).length} memory files`,
      );
    }

    logger.log(`Done. Seeded ${PERSONA_SEEDS.length} persona(s).`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error("seed:personas failed:", err);
  process.exit(1);
});
