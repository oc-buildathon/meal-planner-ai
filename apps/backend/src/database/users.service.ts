import { Injectable, Inject, Logger } from "@nestjs/common";
import { DatabaseService } from "./database.service";
import type { Platform } from "../messaging/messaging.types";

/**
 * Row shape returned for a user record. All dates are ISO strings (SQLite TEXT).
 */
export interface UserRow {
  id: number;
  platform: Platform;
  platform_user_id: string;
  chat_id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  language_code: string | null;
  is_bot: number;
  is_group: number;
  thread_id: string | null;
  message_count: number;
  created_at: string;
  last_seen_at: string;
}

export interface UpsertUserInput {
  platform: Platform;
  platformUserId: string;
  chatId: string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  languageCode?: string | null;
  isBot?: boolean;
  isGroup?: boolean;
}

/**
 * UsersService — CRUD + upsert for the `users` table.
 *
 * Every incoming message from any adapter funnels through `upsert()` which
 * idempotently inserts or updates the user row and bumps last_seen_at /
 * message_count in one statement.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(@Inject(DatabaseService) private readonly dbs: DatabaseService) {}

  /**
   * Insert-or-update a user, keyed on (platform, platform_user_id).
   * Bumps last_seen_at and message_count on every call.
   * Returns the full row after the operation.
   */
  upsert(input: UpsertUserInput): UserRow {
    const db = this.dbs.db;

    const stmt = db.query<UserRow, any>(`
      INSERT INTO users (
        platform, platform_user_id, chat_id, username,
        first_name, last_name, language_code, is_bot, is_group,
        message_count, created_at, last_seen_at
      ) VALUES (
        $platform, $platformUserId, $chatId, $username,
        $firstName, $lastName, $languageCode, $isBot, $isGroup,
        1, datetime('now'), datetime('now')
      )
      ON CONFLICT(platform, platform_user_id) DO UPDATE SET
        chat_id       = excluded.chat_id,
        username      = COALESCE(excluded.username, users.username),
        first_name    = COALESCE(excluded.first_name, users.first_name),
        last_name     = COALESCE(excluded.last_name, users.last_name),
        language_code = COALESCE(excluded.language_code, users.language_code),
        is_bot        = excluded.is_bot,
        is_group      = excluded.is_group,
        message_count = users.message_count + 1,
        last_seen_at  = datetime('now')
      RETURNING *;
    `);

    const row = stmt.get({
      $platform: input.platform,
      $platformUserId: input.platformUserId,
      $chatId: input.chatId,
      $username: input.username ?? null,
      $firstName: input.firstName ?? null,
      $lastName: input.lastName ?? null,
      $languageCode: input.languageCode ?? null,
      $isBot: input.isBot ? 1 : 0,
      $isGroup: input.isGroup ? 1 : 0,
    });

    if (!row) {
      throw new Error(
        `Failed to upsert user ${input.platform}:${input.platformUserId}`,
      );
    }

    return row;
  }

  /** Find a user by internal primary key. */
  findById(id: number): UserRow | null {
    return (
      this.dbs.db
        .query<UserRow, any>(`SELECT * FROM users WHERE id = $id`)
        .get({ $id: id }) ?? null
    );
  }

  /** Find a user by platform identifier. */
  findByPlatform(platform: Platform, platformUserId: string): UserRow | null {
    return (
      this.dbs.db
        .query<UserRow, any>(
          `SELECT * FROM users WHERE platform = $platform AND platform_user_id = $id`,
        )
        .get({ $platform: platform, $id: platformUserId }) ?? null
    );
  }

  /** Find a user row by chat id (used when resolving outgoing replies). */
  findByChatId(platform: Platform, chatId: string): UserRow | null {
    return (
      this.dbs.db
        .query<UserRow, any>(
          `SELECT * FROM users
           WHERE platform = $platform AND chat_id = $chat_id
           ORDER BY last_seen_at DESC
           LIMIT 1`,
        )
        .get({ $platform: platform, $chat_id: chatId }) ?? null
    );
  }

  /** Persist the langgraph thread id for a user (used for multi-turn continuity). */
  setThreadId(userId: number, threadId: string): void {
    this.dbs.db
      .query(`UPDATE users SET thread_id = $tid WHERE id = $uid`)
      .run({ $tid: threadId, $uid: userId });
  }

  /** List all known users (most recently active first). */
  list(limit = 100): UserRow[] {
    return this.dbs.db
      .query<UserRow, any>(
        `SELECT * FROM users ORDER BY last_seen_at DESC LIMIT $lim`,
      )
      .all({ $lim: limit });
  }

  /** Count of distinct registered users. */
  count(): number {
    const row = this.dbs.db
      .query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM users`)
      .get();
    return row?.c ?? 0;
  }
}
