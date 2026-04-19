import { Controller, Get, Post, Body, Inject } from "@nestjs/common";
import { MessagingService } from "./messaging/messaging.service";
import { LlmService } from "./llm/llm.service";
import { OrchestratorService } from "./agents/orchestrator.service";

@Controller()
export class AppController {
  constructor(
    @Inject(MessagingService) private readonly messagingService: MessagingService,
    @Inject(LlmService) private readonly llmService: LlmService,
    @Inject(OrchestratorService) private readonly orchestrator: OrchestratorService,
  ) {}

  @Get()
  root() {
    return { message: "MealPrep Agent API" };
  }

  @Get("health")
  health() {
    const adapters = this.messagingService.getActiveAdapters();
    const llm = this.llmService.getInfo();
    const agent = this.orchestrator.getInfo();
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      agent,
      llm,
      adapters,
    };
  }

  /**
   * POST /chat — test the deep agent directly via HTTP.
   * Simulates a WhatsApp-like message without needing an actual adapter.
   *
   * Body: { "message": "suggest dinner for tonight", "chatId"?: "test-user" }
   */
  @Post("chat")
  async chat(@Body() body: { message: string; chatId?: string }) {
    const chatId = body.chatId ?? "http-test-user";
    const message = body.message;

    if (!message) {
      return { error: "message is required" };
    }

    // Build a synthetic IncomingMessage
    const syntheticMsg = {
      id: `http-${Date.now()}`,
      platform: "whatsapp" as const,
      senderId: chatId,
      senderName: "HTTP Test User",
      chatId,
      isGroup: false,
      type: "text" as const,
      text: message,
      timestamp: new Date(),
    };

    // Collect the reply by temporarily intercepting sendMessage
    let reply: string | null = null;
    const origSend = this.messagingService.sendMessage.bind(this.messagingService);
    this.messagingService.sendMessage = async (msg) => {
      if (msg.chatId === chatId && msg.text) {
        reply = msg.text;
      }
    };

    try {
      await this.orchestrator.processMessage(syntheticMsg);
    } finally {
      this.messagingService.sendMessage = origSend;
    }

    return {
      chatId,
      input: message,
      reply: reply ?? "(no reply)",
    };
  }
}
