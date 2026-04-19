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
import { normalizedToTelegramHtml } from "../messaging/formatting";

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

    // Telegram Mini App → bot: Telegram.WebApp.sendData(...) arrives as a
    // regular message whose `web_app_data` field holds the payload string.
    this.bot.on("message", (ctx, next) => {
      const msg: any = ctx.message;
      if (msg && "web_app_data" in msg && msg.web_app_data) {
        return this.handleMessage(ctx, "web_app_data");
      }
      return next?.();
    });

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
      const replyParams: Record<string, any> = message.replyToMessageId
        ? {
            reply_parameters: {
              message_id: parseInt(message.replyToMessageId),
            },
          }
        : {};

      // Attach a Mini App button as a one-time reply keyboard, if
      // requested. Keyboard-button-launched Mini Apps are the only kind
      // that can post data back via `sendData`.
      if (message.webAppButton) {
        replyParams.reply_markup = {
          keyboard: [
            [
              {
                text: message.webAppButton.text,
                web_app: { url: message.webAppButton.url },
              },
            ],
          ],
          resize_keyboard: true,
          one_time_keyboard: true,
          is_persistent: false,
        };
      }

      // Render the normalized chat format into Telegram HTML so
      // `*bold*` and `_italic_` actually look bold/italic.
      const htmlText = message.text
        ? normalizedToTelegramHtml(message.text)
        : "";
      const htmlCaption =
        message.caption != null
          ? normalizedToTelegramHtml(message.caption)
          : message.text != null
            ? normalizedToTelegramHtml(message.text)
            : undefined;

      switch (message.type) {
        case "text":
          await this.sendTextSafe(chatId, htmlText, replyParams);
          break;

        case "image":
          if (message.media) {
            await this.bot.telegram.sendPhoto(
              chatId,
              { source: message.media },
              {
                caption: htmlCaption,
                parse_mode: "HTML",
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
                caption: htmlCaption,
                parse_mode: "HTML",
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
              {
                caption: htmlCaption,
                parse_mode: "HTML",
                ...replyParams,
              },
            );
          }
          break;

        default:
          await this.sendTextSafe(chatId, htmlText, replyParams);
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
    // Log the raw incoming update FIRST — before any normalization, media
    // download, DB writes, user upsert, or agent routing. This guarantees
    // we always see that a message arrived even if downstream processing
    // errors out.
    this.logIncoming(ctx, type);

    if (!ctx.message || !ctx.from) return;

    // Show "typing…" to the user while we process — deferred by a few
    // hundred ms so instant replies don't produce a typing flash, and
    // refreshed periodically because Telegram auto-clears the action
    // after ~5s.
    const typing = this.startTypingIndicator(ctx.message.chat.id);

    try {
      const normalized = await this.normalizeMessage(ctx, type);
      if (normalized && this.messageHandler) {
        await this.messageHandler(normalized);
      }
    } catch (error) {
      this.logger.error(`Error processing Telegram message: ${error}`);
    } finally {
      typing.stop();
    }
  }

  /**
   * Send a text message using `parse_mode: "HTML"`, falling back to
   * plain text if Telegram complains about the markup (unmatched entity,
   * unsupported tag, etc.). This guarantees the user always gets the
   * content even if formatting fails.
   */
  private async sendTextSafe(
    chatId: number | string,
    html: string,
    extra: Record<string, any>,
  ): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.telegram.sendMessage(chatId, html, {
        parse_mode: "HTML",
        ...extra,
      });
      return;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/parse|entity/i.test(msg)) {
        this.logger.warn(
          `HTML parse failed, falling back to plain text: ${msg}`,
        );
        const plain = html
          .replace(/<[^>]+>/g, "")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&");
        await this.bot.telegram.sendMessage(chatId, plain, extra);
        return;
      }
      throw e;
    }
  }

  /**
   * Start a "typing…" chat-action loop for a chat. Returns a handle with
   * `stop()` that cancels the loop. Safe to call repeatedly; failures are
   * swallowed so the indicator never breaks message handling.
   *
   * Behaviour:
   *   - t=0ms:    scheduled (deferred so very-fast replies don't flash)
   *   - t=300ms:  first sendChatAction("typing") fires
   *   - then every 4s we re-send (Telegram auto-clears "typing" after 5s)
   *   - stop()    cancels any pending timer and any interval
   */
  private startTypingIndicator(chatId: number | string): { stop: () => void } {
    let stopped = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const send = () => {
      if (stopped || !this.bot) return;
      this.bot.telegram
        .sendChatAction(chatId, "typing")
        .catch((e) => this.logger.debug(`sendChatAction failed: ${e}`));
    };

    const initial = setTimeout(() => {
      if (stopped) return;
      send();
      interval = setInterval(send, 4000);
    }, 300);

    return {
      stop: () => {
        stopped = true;
        clearTimeout(initial);
        if (interval) clearInterval(interval);
      },
    };
  }

  /**
   * Immediate, side-effect-free log line emitted the moment a message
   * arrives from Telegram. Kept defensive (no throwing) so logging never
   * breaks message handling.
   */
  private logIncoming(ctx: Context, type: MessageContentType) {
    try {
      const msg: any = ctx.message;
      const from: any = ctx.from;

      const senderId = from?.id ?? "?";
      const senderName =
        [from?.first_name, from?.last_name].filter(Boolean).join(" ").trim() ||
        from?.username ||
        String(senderId);
      const chatId = msg?.chat?.id ?? "?";
      const chatType = msg?.chat?.type ?? "?";
      const messageId = msg?.message_id ?? "?";

      // Pull the best "preview" text we can — text body, caption, or
      // web-app payload — so the log line is informative at a glance.
      let preview: string | undefined;
      if (msg) {
        if (typeof msg.text === "string") preview = msg.text;
        else if (typeof msg.caption === "string") preview = msg.caption;
        else if (msg.web_app_data?.data) preview = msg.web_app_data.data;
      }
      const previewTrimmed = preview
        ? preview.replace(/\s+/g, " ").slice(0, 120) +
          (preview.length > 120 ? "…" : "")
        : "";

      this.logger.log(
        `⇢ IN [${type}] msg=${messageId} chat=${chatId}(${chatType}) ` +
          `from=${senderName}(${senderId})` +
          (previewTrimmed ? ` — "${previewTrimmed}"` : ""),
      );
    } catch (e) {
      // Logging must never throw.
      this.logger.debug(`logIncoming error: ${e}`);
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

    // Telegram Mini App payload — `msg.web_app_data.data` is the string
    // `Telegram.WebApp.sendData(...)` posted from the browser.
    let webAppData: string | undefined;
    if (type === "web_app_data" && "web_app_data" in (msg as any)) {
      const wad = (msg as any).web_app_data;
      if (wad?.data && typeof wad.data === "string") {
        webAppData = wad.data;
        text = wad.data; // also expose as text for downstream logging
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
      webAppData,
      timestamp: new Date(msg.date * 1000),
      raw: msg,
      dbUserId,
    };
  }
}
