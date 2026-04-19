import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DatabaseService } from "./database.service";
import { UsersService } from "./users.service";
import { MessageLogService } from "./message-log.service";
import { GroupMealsService } from "./group-meals.service";

/**
 * DatabaseModule — global SQLite layer.
 *
 * Marked @Global so TelegramService, OrchestratorService, etc. can inject
 * UsersService / MessageLogService / GroupMealsService without every
 * consumer importing this module.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    DatabaseService,
    UsersService,
    MessageLogService,
    GroupMealsService,
  ],
  exports: [
    DatabaseService,
    UsersService,
    MessageLogService,
    GroupMealsService,
  ],
})
export class DatabaseModule {}
