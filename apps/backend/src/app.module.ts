import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AppController } from "./app.controller";
import { DatabaseModule } from "./database/database.module";
import { LlmModule } from "./llm/llm.module";
import { MessagingModule } from "./messaging/messaging.module";
import { AgentsModule } from "./agents/agents.module";
import { WhatsAppModule } from "./whatsapp/whatsapp.module";
import { TelegramModule } from "./telegram/telegram.module";
import { WebAppModule } from "./webapp/webapp.module";
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
    DatabaseModule, // SQLite — must come first so other modules can inject UsersService
    LlmModule,
    MessagingModule,
    AgentsModule,  // Deep agent brain — must come after MessagingModule
    WhatsAppModule,
    TelegramModule,
    WebAppModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
