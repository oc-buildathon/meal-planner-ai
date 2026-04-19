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
        is_persona         INTEGER NOT NULL DEFAULT 0,
        thread_id          TEXT,
        message_count      INTEGER NOT NULL DEFAULT 0,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at       TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(platform, platform_user_id)
      );
    `);

    // Idempotent ALTER for DBs that pre-date the is_persona column.
    this.addColumnIfMissing(
      "users",
      "is_persona",
      "INTEGER NOT NULL DEFAULT 0",
    );

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

    // -------------------------------------------------------------
    // Key-value store for the deep-agent's persistent memory
    // (implements the LangGraph `BaseStore` contract in SqliteStore).
    // -------------------------------------------------------------
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_store (
        namespace    TEXT NOT NULL,
        key          TEXT NOT NULL,
        value_json   TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now','subsec')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now','subsec')),
        PRIMARY KEY (namespace, key)
      );
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_store_namespace
        ON agent_store(namespace);
    `);

    // -------------------------------------------------------------
    // Group meal planning: a user invites others to contribute
    // meal preferences for a joint meal (dinner, party, etc.).
    // -------------------------------------------------------------
    db.exec(`
      CREATE TABLE IF NOT EXISTS group_meal_requests (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        initiator_id    INTEGER NOT NULL,
        title           TEXT NOT NULL,
        prompt          TEXT,
        status          TEXT NOT NULL
                         CHECK(status IN ('collecting','complete','cancelled'))
                         DEFAULT 'collecting',
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at    TEXT,
        FOREIGN KEY(initiator_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS group_meal_participants (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id      INTEGER NOT NULL,
        user_id         INTEGER NOT NULL,
        status          TEXT NOT NULL
                         CHECK(status IN ('invited','responded','declined'))
                         DEFAULT 'invited',
        response_text   TEXT,
        invited_at      TEXT NOT NULL DEFAULT (datetime('now')),
        responded_at    TEXT,
        FOREIGN KEY(request_id) REFERENCES group_meal_requests(id) ON DELETE CASCADE,
        FOREIGN KEY(user_id)    REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(request_id, user_id)
      );
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_gmp_user_status
        ON group_meal_participants(user_id, status);
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_gmp_request
        ON group_meal_participants(request_id);
    `);
  }

  /**
   * Add a column to an existing table if (and only if) it doesn't already
   * exist. SQLite lacks `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so we
   * inspect `PRAGMA table_info` first.
   */
  private addColumnIfMissing(
    table: string,
    column: string,
    columnDdl: string,
  ): void {
    const rows = this._db!
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all();
    if (rows.some((r) => r.name === column)) return;
    this._db!.exec(
      `ALTER TABLE ${table} ADD COLUMN ${column} ${columnDdl};`,
    );
    this.logger.log(`Migrated: added ${table}.${column}`);
  }
}
