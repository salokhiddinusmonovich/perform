import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import {
  createPlatformUserSchema,
  platformMembershipSchema,
  updatePlatformUserSchema,
  type CreatePlatformUser,
  type PlatformMembership,
  type UpdatePlatformUser,
} from '@puantaj/schemas';
import { Auth, PlatformAdminOnly, type AuthContext } from '../auth/auth.context';
import { ZodPipe } from '../common/zod.pipe';
import { PlatformUsersService, type PlatformUserView } from './platform-users.service';

@PlatformAdminOnly()
@Controller('platform/users')
export class PlatformUsersController {
  constructor(private readonly users: PlatformUsersService) {}

  @Get()
  list(): Promise<PlatformUserView[]> {
    return this.users.list();
  }

  @Post()
  create(@Auth() auth: AuthContext, @Body(new ZodPipe(createPlatformUserSchema)) body: CreatePlatformUser) {
    return this.users.create(auth, body);
  }

  @Patch(':id')
  @HttpCode(204)
  update(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updatePlatformUserSchema)) body: UpdatePlatformUser,
  ): Promise<void> {
    return this.users.update(auth, id, body);
  }

  @Post(':id/reset-password')
  resetPassword(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.resetPassword(auth, id);
  }

  @Put(':id/memberships/:companyId')
  @HttpCode(204)
  setMembership(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body(new ZodPipe(platformMembershipSchema)) body: PlatformMembership,
  ): Promise<void> {
    return this.users.setMembership(auth, id, companyId, body);
  }

  /** Log in as this user: the session acts as them until it ends (at most an hour). */
  @Post(':id/impersonate')
  impersonate(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<{ endsAt: Date }> {
    return this.users.impersonate(auth, id);
  }
}
