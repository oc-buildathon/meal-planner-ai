import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AppController } from "./app.controller";
import { LlmModule } from "./llm/llm.module";
import { MessagingModule } from "./messaging/messaging.module";
import { WhatsAppModule } from "./whatsapp/whatsapp.module";
import { TelegramModule } from "./telegram/telegram.module";
import configuration from "./config/configuration";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: [
        "apps/backend/.env",  // from monorepo root (bun run dev)
        ".env",               // from apps/backend/ (direct run)
      ],
    }),
    LlmModule,
    MessagingModule,
    WhatsAppModule,
    TelegramModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
