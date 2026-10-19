import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';

@Module({
  imports: [UsersModule],
  controllers: [PlatformController],
  providers: [PlatformService],
})
export class PlatformModule {}
