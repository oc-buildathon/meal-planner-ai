import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { WebAppController } from "./webapp.controller";

/**
 * WebAppModule — serves the Telegram Mini App UI (`/webapp/select-users`)
 * and the signed JSON API (`/webapp/api/users`) used to render the
 * participant picker.
 *
 * DatabaseModule is @Global, so UsersService is injected automatically.
 */
@Module({
  imports: [ConfigModule],
  controllers: [WebAppController],
})
export class WebAppModule {}
