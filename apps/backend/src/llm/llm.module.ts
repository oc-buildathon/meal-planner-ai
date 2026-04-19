import { Module, Global } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { LlmService } from "./llm.service";

@Global()
@Module({
  imports: [ConfigModule],
  providers: [LlmService],
  exports: [LlmService],
})
export class LlmModule {}
