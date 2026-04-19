import type {
  OutgoingMessage,
  MessageHandler,
  AdapterStatus,
  Platform,
} from "../messaging.types";

/**
 * Interface that all messaging platform adapters must implement.
 * This ensures WhatsApp and Telegram (and any future platform) are interchangeable.
 */
export interface MessagingAdapter {
  /** Which platform this adapter handles */
  readonly platform: Platform;

  /**
   * Initialize the adapter (connect to platform, authenticate, etc.)
   * Called once during NestJS module init.
   */
  initialize(): Promise<void>;

  /**
   * Register a callback that will be invoked on every incoming message.
   * The messaging service sets this during init.
   */
  onMessage(handler: MessageHandler): void;

  /**
   * Send a message through this adapter.
   */
  sendMessage(message: OutgoingMessage): Promise<void>;

  /**
   * Get current connection/status info for health checks.
   */
  getStatus(): AdapterStatus;

  /**
   * Gracefully disconnect and clean up resources.
   */
  shutdown(): Promise<void>;
}
