import { Module } from '@nestjs/common';
import { UserAccountsService } from './user-accounts.service';

@Module({
  providers: [UserAccountsService],
  exports: [UserAccountsService],
})
export class UsersModule {}
