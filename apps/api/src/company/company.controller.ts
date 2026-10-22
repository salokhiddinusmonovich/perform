import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  companySettingsSchema,
  createMemberSchema,
  updateMemberSchema,
  type CompanySettings,
  type CreateMember,
  type UpdateMember,
} from '@puantaj/schemas';
import { AuditService, diff } from '../audit/audit.service';
import { CompanyAuth, ForModule, Roles, type CompanyAuthContext } from '../auth/auth.context';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { MembersService, type MemberView } from './members.service';

/** The logged-in user's active company. Managing it is for owners and admins. */
@ForModule('PAYROLL')
@Roles('OWNER', 'ADMIN')
@Controller('company')
export class CompanyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly members: MembersService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async get(@CompanyAuth() auth: CompanyAuthContext): Promise<CompanySettings> {
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: auth.company.id } });
    return { name: company.name, currency: company.currency, timezone: company.timezone };
  }

  @Patch()
  @HttpCode(204)
  async update(
    @CompanyAuth() auth: CompanyAuthContext,
    @Body(new ZodPipe(companySettingsSchema)) body: CompanySettings,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.company.findUniqueOrThrow({ where: { id: auth.company.id } });
      await tx.company.update({ where: { id: auth.company.id }, data: body });
      await this.audit.record(
        {
          action: 'company.update',
          companyId: auth.company.id,
          auth,
          entityType: 'Company',
          entityId: auth.company.id,
          data: diff({ name: before.name, currency: before.currency, timezone: before.timezone }, body),
        },
        tx,
      );
    });
  }

  @Get('members')
  listMembers(@CompanyAuth() auth: CompanyAuthContext): Promise<MemberView[]> {
    return this.members.list(auth);
  }

  @Post('members')
  createMember(
    @CompanyAuth() auth: CompanyAuthContext,
    @Body(new ZodPipe(createMemberSchema)) body: CreateMember,
  ) {
    return this.members.create(auth, body);
  }

  @Patch('members/:userId')
  @HttpCode(204)
  updateMember(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(new ZodPipe(updateMemberSchema)) body: UpdateMember,
  ): Promise<void> {
    return this.members.update(auth, userId, body);
  }

  @Post('members/:userId/reset-password')
  resetPassword(@CompanyAuth() auth: CompanyAuthContext, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.members.resetPassword(auth, userId);
  }
}
