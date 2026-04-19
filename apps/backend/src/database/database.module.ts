import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DatabaseService } from "./database.service";
import { UsersService } from "./users.service";
import { MessageLogService } from "./message-log.service";

/**
 * DatabaseModule — global SQLite layer.
 *
 * Marked @Global so TelegramService, OrchestratorService, etc. can inject
 * UsersService / MessageLogService without every consumer importing this module.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [DatabaseService, UsersService, MessageLogService],
  exports: [DatabaseService, UsersService, MessageLogService],
})
export class DatabaseModule {}
