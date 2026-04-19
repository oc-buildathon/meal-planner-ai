import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  type WASocket,
  type BaileysEventMap,
} from "baileys";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const qrcode = require("qrcode-terminal");
import type { MessagingAdapter } from "../messaging/adapters/adapter.interface";
import type {
  IncomingMessage,
  OutgoingMessage,
  MessageHandler,
  AdapterStatus,
  MessageContentType,
} from "../messaging/messaging.types";
import { MessagingService } from "../messaging/messaging.service";

@Injectable()
export class WhatsAppService
  implements MessagingAdapter, OnModuleInit, OnModuleDestroy
{
  readonly platform = "whatsapp" as const;

  private readonly logger = new Logger(WhatsAppService.name);
  private sock: WASocket | null = null;
  private messageHandler: MessageHandler | null = null;
  private connected = false;
  private enabled = false;
  private pairingInProgress = false;
  private reconnectAttempt = 0;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(MessagingService) private readonly messagingService: MessagingService,
  ) {}

  async onModuleInit() {
    this.enabled = this.config.get<boolean>("whatsapp.enabled") ?? false;
    if (!this.enabled) {
      this.logger.warn(
        "WhatsApp adapter is DISABLED (set WHATSAPP_ENABLED=true)",
      );
      return;
    }

    // Register with the unified messaging service
    this.messagingService.registerAdapter(this);

    await this.initialize();
  }

  async onModuleDestroy() {
    await this.shutdown();
  }

  // ─── MessagingAdapter interface ─────────────────────────────────

  async initialize() {
    const authDir = this.config.get<string>("whatsapp.authDir")!;
    const phoneNumber = this.config.get<string>("whatsapp.phoneNumber") ?? "";
    this.logger.log(`Initializing Baileys… auth dir: ${authDir}`);
    if (phoneNumber) {
      this.logger.log(`Using phone number pairing: ${phoneNumber}`);
    } else {
      this.logger.log("Using QR code pairing (scan with WhatsApp)");
    }

    await this.connect(authDir, phoneNumber);
  }

  onMessage(handler: MessageHandler) {
    this.messageHandler = handler;
  }

  async sendMessage(message: OutgoingMessage): Promise<void> {
    if (!this.sock) {
      this.logger.error("Cannot send — WhatsApp socket not connected");
      return;
    }

    const jid = message.chatId;

    try {
      switch (message.type) {
        case "text":
          await this.sock.sendMessage(jid, {
            text: message.text ?? "",
          });
          break;

        case "image":
          if (message.media) {
            await this.sock.sendMessage(jid, {
              image: message.media,
              caption: message.caption ?? message.text,
              mimetype:
                (message.mediaMimeType as `${string}/${string}`) ??
                "image/jpeg",
            });
          }
          break;

        case "audio":
          if (message.media) {
            await this.sock.sendMessage(jid, {
              audio: message.media,
              mimetype:
                (message.mediaMimeType as `${string}/${string}`) ??
                "audio/ogg; codecs=opus",
              ptt: true,
            });
          }
          break;

        case "video":
          if (message.media) {
            await this.sock.sendMessage(jid, {
              video: message.media,
              caption: message.caption ?? message.text,
              mimetype:
                (message.mediaMimeType as `${string}/${string}`) ?? "video/mp4",
            });
          }
          break;

        case "document":
          if (message.media) {
            await this.sock.sendMessage(jid, {
              document: message.media,
              fileName: message.mediaFilename ?? "file",
              mimetype:
                (message.mediaMimeType as `${string}/${string}`) ??
                "application/octet-stream",
            });
          }
          break;

        default:
          await this.sock.sendMessage(jid, {
            text: message.text ?? "",
          });
      }
    } catch (error) {
      this.logger.error(
        `Failed to send WhatsApp message to ${jid}: ${error}`,
      );
    }
  }

  getStatus(): AdapterStatus {
    return {
      platform: "whatsapp",
      enabled: this.enabled,
      connected: this.connected,
      info: this.connected ? "Connected to WhatsApp Web" : "Disconnected",
    };
  }

  async shutdown() {
    if (this.sock) {
      this.logger.log("Shutting down WhatsApp socket…");
      this.sock.end(undefined);
      this.sock = null;
      this.connected = false;
    }
  }

  // ─── Baileys connection logic ───────────────────────────────────

  private async connect(authDir: string, phoneNumber?: string) {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const isRegistered = state.creds.registered;
    const needsPairing = !!phoneNumber && !isRegistered;

    // Baileys 7.x: do NOT pass printQRInTerminal (deprecated)
    this.sock = makeWASocket({
      auth: state,
      // Longer keepalive during pairing to avoid premature disconnects
      keepAliveIntervalMs: needsPairing ? 30_000 : 15_000,
      // Increase connection timeout to give time for pairing
      connectTimeoutMs: needsPairing ? 60_000 : 20_000,
    });

    // If phone number is provided and not yet registered, request a pairing code
    if (needsPairing) {
      this.pairingInProgress = true;
      // Wait for the socket to fully connect to WA servers before requesting code
      this.sock.ev.on("connection.update", async (update) => {
        // Once we get the first connection update with no QR (phone pairing mode),
        // wait a moment then request the pairing code
        if (update.connection === undefined && !update.qr && this.pairingInProgress) {
          return; // skip intermediate updates
        }
      });

      // Request pairing code after a delay to let socket handshake complete
      setTimeout(async () => {
        if (!this.pairingInProgress || !this.sock) return;
        try {
          const code = await this.sock.requestPairingCode(phoneNumber);
          this.logger.log(
            `\n` +
            `╔══════════════════════════════════════════════╗\n` +
            `║                                              ║\n` +
            `║   WhatsApp Pairing Code:  ${code}             ║\n` +
            `║                                              ║\n` +
            `║   1. Open WhatsApp on your phone             ║\n` +
            `║   2. Go to Linked Devices                    ║\n` +
            `║   3. Tap "Link a Device"                     ║\n` +
            `║   4. Tap "Link with phone number instead"    ║\n` +
            `║   5. Enter the code above                    ║\n` +
            `║                                              ║\n` +
            `║   You have ~60 seconds to enter it.          ║\n` +
            `║                                              ║\n` +
            `╚══════════════════════════════════════════════╝\n`,
          );
        } catch (e) {
          this.logger.error(`Failed to request pairing code: ${e}`);
        }
      }, 5000);
    }

    // Persist auth credentials on update
    this.sock.ev.on("creds.update", saveCreds);

    // Connection state changes + QR code handling
    this.sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      // QR code mode (no phone number set)
      if (qr && !needsPairing) {
        this.logger.log(
          "\n╔══════════════════════════════════════════╗\n" +
          "║   Scan this QR code with WhatsApp        ║\n" +
          "║   Open WhatsApp > Linked Devices > Link  ║\n" +
          "╚══════════════════════════════════════════╝\n",
        );
        qrcode.generate(qr, { small: true });
      }

      if (connection === "open") {
        this.connected = true;
        this.pairingInProgress = false;
        this.reconnectAttempt = 0;
        const user = this.sock?.user;
        this.logger.log(
          `WhatsApp connected! Logged in as: ${user?.name ?? user?.id ?? "unknown"}`,
        );
      }

      if (connection === "close") {
        this.connected = false;
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut;

        if (!shouldReconnect) {
          this.pairingInProgress = false;
          this.logger.error(
            "WhatsApp logged out. Delete auth_sessions/ dir and restart to re-pair.",
          );
          return;
        }

        // During pairing: use longer delay (20s) to avoid regenerating codes too fast
        // After paired: use exponential backoff (3s, 6s, 12s… capped at 60s)
        let delay: number;
        if (this.pairingInProgress) {
          delay = 20_000;
          this.logger.warn(
            `WhatsApp disconnected during pairing (code=${statusCode}). ` +
            `Retrying in ${delay / 1000}s — keep WhatsApp open on your phone…`,
          );
        } else {
          this.reconnectAttempt++;
          delay = Math.min(3000 * Math.pow(2, this.reconnectAttempt - 1), 60_000);
          this.logger.warn(
            `WhatsApp disconnected (code=${statusCode}), reconnecting in ${delay / 1000}s… (attempt #${this.reconnectAttempt})`,
          );
        }

        setTimeout(() => this.connect(authDir, phoneNumber), delay);
      }
    });

    // Incoming messages
    this.sock.ev.on(
      "messages.upsert",
      async (upsert: BaileysEventMap["messages.upsert"]) => {
        if (upsert.type !== "notify") return;

        for (const msg of upsert.messages) {
          if (msg.key.fromMe) continue;
          if (!msg.message) continue;

          try {
            const normalized = await this.normalizeMessage(msg);
            if (normalized && this.messageHandler) {
              await this.messageHandler(normalized);
            }
          } catch (error) {
            this.logger.error(
              `Error processing WhatsApp message: ${error}`,
            );
          }
        }
      },
    );
  }

  // ─── Message normalization ──────────────────────────────────────

  private async normalizeMessage(
    msg: any,
  ): Promise<IncomingMessage | null> {
    const key = msg.key;
    const chatId = key.remoteJid;
    if (!chatId) return null;

    const isGroup = chatId.endsWith("@g.us");
    const senderId = isGroup ? (key.participant ?? chatId) : chatId;
    const senderName = msg.pushName ?? senderId.split("@")[0];

    const messageContent = msg.message;
    let type: MessageContentType = "text";
    let text: string | undefined;
    let media: Buffer | undefined;
    let mediaMimeType: string | undefined;
    let mediaFilename: string | undefined;

    if (messageContent.conversation) {
      type = "text";
      text = messageContent.conversation;
    } else if (messageContent.extendedTextMessage) {
      type = "text";
      text = messageContent.extendedTextMessage.text;
    } else if (messageContent.imageMessage) {
      type = "image";
      text = messageContent.imageMessage.caption;
      mediaMimeType = messageContent.imageMessage.mimetype;
      try {
        const stream = await downloadMediaMessage(msg, "buffer", {});
        media = stream as Buffer;
      } catch (e) {
        this.logger.warn(`Failed to download image: ${e}`);
      }
    } else if (messageContent.audioMessage) {
      type = "audio";
      mediaMimeType = messageContent.audioMessage.mimetype;
      try {
        const stream = await downloadMediaMessage(msg, "buffer", {});
        media = stream as Buffer;
      } catch (e) {
        this.logger.warn(`Failed to download audio: ${e}`);
      }
    } else if (messageContent.videoMessage) {
      type = "video";
      text = messageContent.videoMessage.caption;
      mediaMimeType = messageContent.videoMessage.mimetype;
      try {
        const stream = await downloadMediaMessage(msg, "buffer", {});
        media = stream as Buffer;
      } catch (e) {
        this.logger.warn(`Failed to download video: ${e}`);
      }
    } else if (messageContent.documentMessage) {
      type = "document";
      text = messageContent.documentMessage.caption;
      mediaMimeType = messageContent.documentMessage.mimetype;
      mediaFilename = messageContent.documentMessage.fileName;
      try {
        const stream = await downloadMediaMessage(msg, "buffer", {});
        media = stream as Buffer;
      } catch (e) {
        this.logger.warn(`Failed to download document: ${e}`);
      }
    } else if (messageContent.stickerMessage) {
      type = "sticker";
      mediaMimeType = messageContent.stickerMessage.mimetype;
    } else if (messageContent.locationMessage) {
      type = "location";
    } else if (messageContent.reactionMessage) {
      type = "reaction";
      text = messageContent.reactionMessage.text;
    } else {
      this.logger.debug(
        `Unhandled WA message type: ${Object.keys(messageContent).join(", ")}`,
      );
      return null;
    }

    return {
      id: key.id ?? "",
      platform: "whatsapp",
      senderId,
      senderName,
      chatId,
      isGroup,
      type,
      text,
      media,
      mediaMimeType,
      mediaFilename,
      location: messageContent.locationMessage
        ? {
            latitude: messageContent.locationMessage.degreesLatitude,
            longitude: messageContent.locationMessage.degreesLongitude,
          }
        : undefined,
      timestamp: new Date((msg.messageTimestamp as number) * 1000),
      raw: msg,
    };
  }
}
