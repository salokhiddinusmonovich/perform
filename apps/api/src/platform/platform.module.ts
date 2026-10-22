import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';
import { PlatformUsersController } from './platform-users.controller';
import { PlatformUsersService } from './platform-users.service';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';

@Module({
  imports: [UsersModule],
  controllers: [PlatformController, PlansController, PlatformUsersController],
  providers: [PlatformService, PlansService, PlatformUsersService],
})
export class PlatformModule {}
