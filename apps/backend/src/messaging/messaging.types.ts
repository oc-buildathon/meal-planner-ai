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
  | "reaction";

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

  /** Timestamp */
  timestamp: Date;

  /** Raw platform-specific message object (for edge cases) */
  raw?: unknown;
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
