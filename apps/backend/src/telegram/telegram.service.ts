import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Telegraf, type Context } from "telegraf";
import type { MessagingAdapter } from "../messaging/adapters/adapter.interface";
import type {
  IncomingMessage,
  OutgoingMessage,
  MessageHandler,
  AdapterStatus,
  MessageContentType,
} from "../messaging/messaging.types";
import { MessagingService } from "../messaging/messaging.service";
import { UsersService } from "../database/users.service";

@Injectable()
export class TelegramService
  implements MessagingAdapter, OnModuleInit, OnModuleDestroy
{
  readonly platform = "telegram" as const;

  private readonly logger = new Logger(TelegramService.name);
  private bot: Telegraf | null = null;
  private messageHandler: MessageHandler | null = null;
  private connected = false;
  private enabled = false;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(MessagingService) private readonly messagingService: MessagingService,
    @Inject(UsersService) private readonly users: UsersService,
  ) {}

  async onModuleInit() {
    this.enabled = this.config.get<boolean>("telegram.enabled") ?? false;
    if (!this.enabled) {
      this.logger.warn(
        "Telegram adapter is DISABLED (set TELEGRAM_ENABLED=true)",
      );
      return;
    }

    const token = this.config.get<string>("telegram.botToken");
    if (!token) {
      this.logger.error("TELEGRAM_BOT_TOKEN is not set — skipping Telegram");
      this.enabled = false;
      return;
    }

    this.messagingService.registerAdapter(this);
    await this.initialize();
  }

  async onModuleDestroy() {
    await this.shutdown();
  }

  // ─── MessagingAdapter interface ─────────────────────────────────

  async initialize() {
    const token = this.config.get<string>("telegram.botToken")!;
    this.bot = new Telegraf(token);

    this.bot.on("text", (ctx) => this.handleMessage(ctx, "text"));
    this.bot.on("photo", (ctx) => this.handleMessage(ctx, "image"));
    this.bot.on("voice", (ctx) => this.handleMessage(ctx, "audio"));
    this.bot.on("audio", (ctx) => this.handleMessage(ctx, "audio"));
    this.bot.on("video", (ctx) => this.handleMessage(ctx, "video"));
    this.bot.on("document", (ctx) => this.handleMessage(ctx, "document"));
    this.bot.on("sticker", (ctx) => this.handleMessage(ctx, "sticker"));
    this.bot.on("location", (ctx) => this.handleMessage(ctx, "location"));

    // Telegraf's launch() is a blocking long-poll loop that never resolves,
    // AND it calls process.once('SIGINT'/'SIGTERM') which throws under Bun.
    //
    // Fix: monkey-patch process.once to swallow signal registration,
    // then fire-and-forget launch() so it doesn't block NestJS startup.
    const origOnce = process.once.bind(process);
    (process as any).once = (event: string, listener: any) => {
      if (event === "SIGINT" || event === "SIGTERM") {
        return process; // swallow — NestJS handles shutdown via onModuleDestroy
      }
      return origOnce(event, listener);
    };

    // Fire-and-forget: launch() runs the polling loop forever
    this.bot.launch({ dropPendingUpdates: true })
      .catch((error) => {
        this.logger.error(`Telegram polling error: ${error}`);
      });

    // Restore process.once after a tick (launch registers signals synchronously)
    setTimeout(() => {
      (process as any).once = origOnce;
    }, 100);

    this.connected = true;
    this.logger.log("Telegram bot started (long-polling)");
  }

  onMessage(handler: MessageHandler) {
    this.messageHandler = handler;
  }

  async sendMessage(message: OutgoingMessage): Promise<void> {
    if (!this.bot) {
      this.logger.error("Cannot send — Telegram bot not initialized");
      return;
    }

    const chatId = message.chatId;

    try {
      const replyParams = message.replyToMessageId
        ? {
            reply_parameters: {
              message_id: parseInt(message.replyToMessageId),
            },
          }
        : {};

      switch (message.type) {
        case "text":
          await this.bot.telegram.sendMessage(
            chatId,
            message.text ?? "",
            replyParams,
          );
          break;

        case "image":
          if (message.media) {
            await this.bot.telegram.sendPhoto(
              chatId,
              { source: message.media },
              {
                caption: message.caption ?? message.text,
                ...replyParams,
              },
            );
          }
          break;

        case "audio":
          if (message.media) {
            await this.bot.telegram.sendVoice(
              chatId,
              { source: message.media },
              replyParams,
            );
          }
          break;

        case "video":
          if (message.media) {
            await this.bot.telegram.sendVideo(
              chatId,
              { source: message.media },
              {
                caption: message.caption ?? message.text,
                ...replyParams,
              },
            );
          }
          break;

        case "document":
          if (message.media) {
            await this.bot.telegram.sendDocument(
              chatId,
              {
                source: message.media,
                filename: message.mediaFilename ?? "file",
              },
              { caption: message.caption, ...replyParams },
            );
          }
          break;

        default:
          await this.bot.telegram.sendMessage(
            chatId,
            message.text ?? "",
            replyParams,
          );
      }
    } catch (error) {
      this.logger.error(
        `Failed to send Telegram message to ${chatId}: ${error}`,
      );
    }
  }

  getStatus(): AdapterStatus {
    return {
      platform: "telegram",
      enabled: this.enabled,
      connected: this.connected,
      info: this.connected
        ? "Telegram bot running (long-polling)"
        : "Disconnected",
    };
  }

  async shutdown() {
    if (this.bot) {
      this.logger.log("Shutting down Telegram bot…");
      this.bot.stop();
      this.bot = null;
      this.connected = false;
    }
  }

  // ─── Message handling ───────────────────────────────────────────

  private async handleMessage(ctx: Context, type: MessageContentType) {
    if (!ctx.message || !ctx.from) return;

    try {
      const normalized = await this.normalizeMessage(ctx, type);
      if (normalized && this.messageHandler) {
        await this.messageHandler(normalized);
      }
    } catch (error) {
      this.logger.error(`Error processing Telegram message: ${error}`);
    }
  }

  private async normalizeMessage(
    ctx: Context,
    type: MessageContentType,
  ): Promise<IncomingMessage | null> {
    const msg = ctx.message;
    if (!msg || !ctx.from) return null;

    const chatId = msg.chat.id.toString();
    const senderId = ctx.from.id.toString();
    const senderName =
      [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") ||
      ctx.from.username ||
      senderId;
    const isGroup =
      msg.chat.type === "group" || msg.chat.type === "supergroup";

    // Persist user (and bump last_seen / message_count) before routing.
    let dbUserId: number | undefined;
    try {
      const userRow = this.users.upsert({
        platform: "telegram",
        platformUserId: senderId,
        chatId,
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name ?? null,
        lastName: ctx.from.last_name ?? null,
        languageCode: ctx.from.language_code ?? null,
        isBot: !!ctx.from.is_bot,
        isGroup,
      });
      dbUserId = userRow.id;
    } catch (e) {
      this.logger.warn(`User upsert failed for ${senderId}: ${e}`);
    }

    let text: string | undefined;
    let media: Buffer | undefined;
    let mediaMimeType: string | undefined;
    let mediaFilename: string | undefined;
    let location: { latitude: number; longitude: number } | undefined;

    if ("text" in msg) {
      text = msg.text;
    }
    if ("caption" in msg) {
      text = (msg as any).caption;
    }

    // Download media from Telegram file API
    if (type === "image" && "photo" in msg) {
      const photos = msg.photo;
      if (photos && photos.length > 0) {
        const photo = photos[photos.length - 1];
        try {
          const fileLink = await ctx.telegram.getFileLink(photo.file_id);
          const response = await fetch(fileLink.toString());
          media = Buffer.from(await response.arrayBuffer());
          mediaMimeType = "image/jpeg";
        } catch (e) {
          this.logger.warn(`Failed to download Telegram photo: ${e}`);
        }
      }
    }

    if (type === "audio" && ("voice" in msg || "audio" in msg)) {
      const audio = "voice" in msg ? msg.voice : (msg as any).audio;
      if (audio) {
        try {
          const fileLink = await ctx.telegram.getFileLink(audio.file_id);
          const response = await fetch(fileLink.toString());
          media = Buffer.from(await response.arrayBuffer());
          mediaMimeType = audio.mime_type ?? "audio/ogg";
        } catch (e) {
          this.logger.warn(`Failed to download Telegram audio: ${e}`);
        }
      }
    }

    if (type === "video" && "video" in msg) {
      const video = msg.video;
      if (video) {
        try {
          const fileLink = await ctx.telegram.getFileLink(video.file_id);
          const response = await fetch(fileLink.toString());
          media = Buffer.from(await response.arrayBuffer());
          mediaMimeType = video.mime_type ?? "video/mp4";
        } catch (e) {
          this.logger.warn(`Failed to download Telegram video: ${e}`);
        }
      }
    }

    if (type === "document" && "document" in msg) {
      const doc = msg.document;
      if (doc) {
        try {
          const fileLink = await ctx.telegram.getFileLink(doc.file_id);
          const response = await fetch(fileLink.toString());
          media = Buffer.from(await response.arrayBuffer());
          mediaMimeType = doc.mime_type ?? "application/octet-stream";
          mediaFilename = doc.file_name;
        } catch (e) {
          this.logger.warn(`Failed to download Telegram document: ${e}`);
        }
      }
    }

    if (type === "location" && "location" in msg) {
      const loc = msg.location;
      if (loc) {
        location = { latitude: loc.latitude, longitude: loc.longitude };
      }
    }

    return {
      id: msg.message_id.toString(),
      platform: "telegram",
      senderId,
      senderName,
      chatId,
      isGroup,
      type,
      text,
      media,
      mediaMimeType,
      mediaFilename,
      location,
      timestamp: new Date(msg.date * 1000),
      raw: msg,
      dbUserId,
    };
  }
}
