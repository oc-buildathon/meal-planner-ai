import { Controller, Get, Inject } from "@nestjs/common";
import { MessagingService } from "./messaging/messaging.service";
import { LlmService } from "./llm/llm.service";

@Controller()
export class AppController {
  constructor(
    @Inject(MessagingService) private readonly messagingService: MessagingService,
    @Inject(LlmService) private readonly llmService: LlmService,
  ) {}

  @Get()
  root() {
    return { message: "MealPrep Agent API" };
  }

  @Get("health")
  health() {
    const adapters = this.messagingService.getActiveAdapters();
    const llm = this.llmService.getInfo();
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      llm,
      adapters,
    };
  }
}
