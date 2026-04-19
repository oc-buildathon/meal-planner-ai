import { Injectable, Inject, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

/**
 * LLM Service — wraps a ChatOpenAI instance pointed at any OpenAI-compatible endpoint.
 *
 * Supports: OpenAI, OpenRouter, Ollama, vLLM, LiteLLM, Azure OpenAI, Together, Groq, etc.
 * Just set LLM_BASE_URL + LLM_API_KEY + LLM_MODEL in your .env
 */
@Injectable()
export class LlmService implements OnModuleInit {
  private readonly logger = new Logger(LlmService.name);
  private chat!: ChatOpenAI;

  constructor(@Inject(ConfigService) private readonly config: ConfigService) { }

  onModuleInit() {
    const baseUrl = this.config.get<string>("LLM_BASE_URL")!;
    const apiKey = this.config.get<string>("LLM_API_KEY")!;
    const model = this.config.get<string>("LLM_MODEL")!;

    this.chat = new ChatOpenAI({
      configuration: {
        baseURL: baseUrl,
      },
      openAIApiKey: apiKey,
      modelName: model,
    });

    this.logger.log(
      `LLM initialized: model=${model} baseUrl=${baseUrl.replace(/\/+$/, "")}`,
    );
  }

  /** Get the raw ChatOpenAI instance (for deepagents or custom chains) */
  getModel(): ChatOpenAI {
    return this.chat;
  }

  /** Simple text completion — send a user message, get a string back */
  async complete(userMessage: string, systemPrompt?: string): Promise<string> {
    const messages = [];
    if (systemPrompt) {
      messages.push(new SystemMessage(systemPrompt));
    }
    messages.push(new HumanMessage(userMessage));

    const response = await this.chat.invoke(messages);
    return typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);
  }

  /** Get model info for health checks */
  getInfo() {
    return {
      model: this.config.get<string>("LLM_MODEL"),
      baseUrl: this.config.get<string>("LLM_BASE_URL"),
    };
  }
}
