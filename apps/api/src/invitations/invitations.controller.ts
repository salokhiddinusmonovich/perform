import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Auth, NotWhileImpersonating, type AuthContext } from '../auth/auth.context';
import { InvitationsService, type InvitationView } from './invitations.service';

/** The logged-in person's own invitations to join companies. */
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get()
  list(@Auth() auth: AuthContext): Promise<InvitationView[]> {
    return this.invitations.list(auth);
  }

  @NotWhileImpersonating()
  @Post(':companyId/accept')
  @HttpCode(204)
  accept(@Auth() auth: AuthContext, @Param('companyId', ParseUUIDPipe) companyId: string): Promise<void> {
    return this.invitations.accept(auth, companyId);
  }

  @NotWhileImpersonating()
  @Post(':companyId/decline')
  @HttpCode(204)
  decline(@Auth() auth: AuthContext, @Param('companyId', ParseUUIDPipe) companyId: string): Promise<void> {
    return this.invitations.decline(auth, companyId);
  }
}
