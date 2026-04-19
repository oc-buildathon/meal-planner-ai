import { Injectable, Inject, Logger } from "@nestjs/common";
import { DatabaseService } from "./database.service";
import type { Platform, MessageContentType } from "../messaging/messaging.types";

export interface LogMessageInput {
  userId: number;
  platform: Platform;
  platformMsgId?: string | null;
  direction: "in" | "out";
  type: MessageContentType;
  text?: string | null;
}

export interface MessageRow {
  id: number;
  user_id: number;
  platform: Platform;
  platform_msg_id: string | null;
  direction: "in" | "out";
  type: MessageContentType;
  text: string | null;
  created_at: string;
}

/**
 * MessageLogService — append-only log of every message routed through the bot.
 *
 * Kept intentionally simple; the deep-agent's LangGraph checkpointer still
 * owns the canonical conversation state. This log is for audit / debugging /
 * future analytics.
 */
@Injectable()
export class MessageLogService {
  private readonly logger = new Logger(MessageLogService.name);

  constructor(@Inject(DatabaseService) private readonly dbs: DatabaseService) {}

  log(input: LogMessageInput): void {
    try {
      this.dbs.db
        .query(
          `INSERT INTO messages (user_id, platform, platform_msg_id, direction, type, text)
           VALUES ($uid, $platform, $msg_id, $dir, $type, $text)`,
        )
        .run({
          $uid: input.userId,
          $platform: input.platform,
          $msg_id: input.platformMsgId ?? null,
          $dir: input.direction,
          $type: input.type,
          $text: input.text ?? null,
        });
    } catch (e) {
      // Logging must never break the hot path.
      this.logger.warn(`Failed to log message: ${e}`);
    }
  }

  /** Most recent N messages for a user (oldest first for conversation display). */
  recentForUser(userId: number, limit = 20): MessageRow[] {
    const rows = this.dbs.db
      .query<MessageRow, any>(
        `SELECT * FROM messages
         WHERE user_id = $uid
         ORDER BY id DESC
         LIMIT $lim`,
      )
      .all({ $uid: userId, $lim: limit });
    return rows.reverse();
  }
}
