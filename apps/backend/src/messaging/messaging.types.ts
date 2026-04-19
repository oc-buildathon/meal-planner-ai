/**
 * Unified messaging types — abstracts over WhatsApp (Baileys) and Telegram.
 * The Agent Brain only works with these types, never platform-specific ones.
 */

export type Platform = "whatsapp" | "telegram";

export type MessageContentType =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "sticker"
  | "location"
  | "reaction"
  | "web_app_data";

/**
 * A normalized incoming message from any platform.
 */
export interface IncomingMessage {
  /** Unique message ID (platform-specific) */
  id: string;

  /** Which platform this came from */
  platform: Platform;

  /** Sender identifier (WhatsApp JID or Telegram user ID) */
  senderId: string;

  /** Sender display name */
  senderName: string;

  /** Chat/conversation ID (could be group or DM) */
  chatId: string;

  /** Whether this is from a group chat */
  isGroup: boolean;

  /** Content type */
  type: MessageContentType;

  /** Text content (body text for text messages, caption for media) */
  text?: string;

  /** Media buffer (downloaded image/audio/video/document bytes) */
  media?: Buffer;

  /** MIME type of the media */
  mediaMimeType?: string;

  /** Original filename for documents */
  mediaFilename?: string;

  /** Location data */
  location?: { latitude: number; longitude: number };

  /**
   * Raw string payload sent back from a Telegram Mini App via
   * `Telegram.WebApp.sendData(...)`. Always expected to be JSON —
   * consumers should JSON.parse defensively.
   */
  webAppData?: string;

  /** Timestamp */
  timestamp: Date;

  /** Raw platform-specific message object (for edge cases) */
  raw?: unknown;

  /**
   * Internal primary-key of the user row in the SQLite `users` table.
   * Set by the adapter after upsert; consumers (orchestrator, logs) use this
   * as the canonical user identifier instead of the platform-specific id.
   */
  dbUserId?: number;
}

/**
 * A normalized outgoing message to send on any platform.
 */
export interface OutgoingMessage {
  /** Target chat ID (WhatsApp JID or Telegram chat ID) */
  chatId: string;

  /** Content type */
  type: MessageContentType;

  /** Text content */
  text?: string;

  /** Media buffer to send */
  media?: Buffer;

  /** MIME type for media */
  mediaMimeType?: string;

  /** Caption for media messages */
  caption?: string;

  /** Filename for documents */
  mediaFilename?: string;

  /** Reply to a specific message ID */
  replyToMessageId?: string;

  /**
   * If set, attach a single one-time reply keyboard with a Telegram
   * Mini App button. Clicking it opens `url` inside the Telegram client
   * and the Mini App can post data back via `tg.sendData(...)`.
   *
   * Ignored on platforms that don't support Mini Apps (WhatsApp).
   */
  webAppButton?: {
    text: string;
    url: string;
  };
}

/**
 * Adapter status info for health checks.
 */
export interface AdapterStatus {
  platform: Platform;
  enabled: boolean;
  connected: boolean;
  info?: string;
}

/**
 * Callback type for when an adapter receives a message.
 */
export type MessageHandler = (message: IncomingMessage) => Promise<void>;
