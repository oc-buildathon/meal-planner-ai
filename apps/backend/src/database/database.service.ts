import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * DatabaseService — owns the single SQLite connection for the app.
 *
 * Uses Bun's built-in `bun:sqlite` driver (no external dependency needed).
 * Runs schema migrations on startup. Exposes the raw `Database` handle for
 * other services (UsersService, MessageLogService) to build statements on top of.
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private _db: Database | null = null;

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  async onModuleInit() {
    const path =
      this.config.get<string>("database.path") ?? "./data/mealprep.db";

    // Ensure parent dir exists
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      /* ignore */
    }

    this._db = new Database(path, { create: true });

    // Sensible pragmas for a small always-on bot
    this._db.exec("PRAGMA journal_mode = WAL;");
    this._db.exec("PRAGMA foreign_keys = ON;");
    this._db.exec("PRAGMA synchronous = NORMAL;");

    this.runMigrations();
    this.logger.log(`SQLite database ready at ${path}`);
  }

  onModuleDestroy() {
    if (this._db) {
      try {
        this._db.close();
      } catch (e) {
        this.logger.warn(`Error closing SQLite: ${e}`);
      }
      this._db = null;
    }
  }

  /** Raw handle — other services use this to prepare their own statements. */
  get db(): Database {
    if (!this._db) {
      throw new Error("DatabaseService accessed before initialization");
    }
    return this._db;
  }

  // -----------------------------------------------------------------
  // Schema
  // -----------------------------------------------------------------

  private runMigrations() {
    const db = this._db!;

    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        platform           TEXT NOT NULL,
        platform_user_id   TEXT NOT NULL,
        chat_id            TEXT NOT NULL,
        username           TEXT,
        first_name         TEXT,
        last_name          TEXT,
        language_code      TEXT,
        is_bot             INTEGER NOT NULL DEFAULT 0,
        is_group           INTEGER NOT NULL DEFAULT 0,
        thread_id          TEXT,
        message_count      INTEGER NOT NULL DEFAULT 0,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at       TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(platform, platform_user_id)
      );
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_users_chat_id
        ON users(platform, chat_id);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id            INTEGER NOT NULL,
        platform           TEXT NOT NULL,
        platform_msg_id    TEXT,
        direction          TEXT NOT NULL CHECK(direction IN ('in','out')),
        type               TEXT NOT NULL,
        text               TEXT,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_user_created
        ON messages(user_id, created_at DESC);
    `);
  }
}
