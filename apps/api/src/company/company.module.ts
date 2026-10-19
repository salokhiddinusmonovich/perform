import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { CompanyController } from './company.controller';
import { MembersService } from './members.service';

@Module({
  imports: [UsersModule],
  controllers: [CompanyController],
  providers: [MembersService],
})
export class CompanyModule {}
