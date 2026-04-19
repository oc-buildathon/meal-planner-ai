import { Module, Global } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AgentMemoryService } from "./memory/memory.service";
import { OrchestratorService } from "./orchestrator.service";

/**
 * Global module — provides the deep agent brain and its memory store.
 *
 * AgentMemoryService seeds the InMemoryStore on startup.
 * OrchestratorService creates the deep agent and registers it as
 * the message processor for the MessagingService.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [AgentMemoryService, OrchestratorService],
  exports: [AgentMemoryService, OrchestratorService],
})
export class AgentsModule {}
