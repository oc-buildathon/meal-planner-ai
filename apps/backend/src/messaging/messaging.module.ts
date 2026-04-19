import { Module, Global } from "@nestjs/common";
import { MessagingService } from "./messaging.service";

/**
 * Global module — MessagingService is available everywhere
 * so adapters and controllers can inject it.
 */
@Global()
@Module({
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
