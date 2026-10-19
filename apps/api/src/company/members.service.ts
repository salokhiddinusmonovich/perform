import { Injectable } from '@nestjs/common';
import type { Role } from '@prisma/client';
import type { CreateMember, UpdateMember } from '@puantaj/schemas';
import { AuditService, diff } from '../audit/audit.service';
import type { CompanyAuthContext } from '../auth/auth.context';
import { generateTemporaryPassword, hashPassword } from '../auth/passwords';
import { badRequest, conflict, forbidden, notFound } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { UserAccountsService } from '../users/user-accounts.service';

export interface MemberView {
  userId: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  role: Role;
  isActive: boolean;
  lastLoginAt: Date | null;
  mustChangePassword: boolean;
  createdAt: Date;
}

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: UserAccountsService,
    private readonly audit: AuditService,
  ) {}

  async list(auth: CompanyAuthContext): Promise<MemberView[]> {
    const rows = await this.prisma.membership.findMany({
      where: { companyId: auth.company.id },
      include: { user: true },
      orderBy: [{ isActive: 'desc' }, { user: { fullName: 'asc' } }],
    });
    return rows.map((m) => ({
      userId: m.userId,
      fullName: m.user.fullName,
      email: m.user.email,
      phone: m.user.phone,
      role: m.role,
      isActive: m.isActive,
      lastLoginAt: m.user.lastLoginAt,
      mustChangePassword: m.user.mustChangePassword,
      createdAt: m.createdAt,
    }));
  }

  /** Adds a person to the company; creates their account if they don't have one yet. */
  async create(auth: CompanyAuthContext, input: CreateMember) {
    assertMayGrant(auth, input.role);
    const { role, ...contact } = input;

    return this.prisma.$transaction(async (tx) => {
      const { user, temporaryPassword } = await this.accounts.findOrCreate(tx, contact);
      const existing = await tx.membership.findUnique({
        where: { userId_companyId: { userId: user.id, companyId: auth.company.id } },
      });
      if (existing) throw conflict('member.alreadyExists');

      await tx.membership.create({ data: { userId: user.id, companyId: auth.company.id, role } });
      await this.audit.record(
        {
          action: 'member.add',
          companyId: auth.company.id,
          actorUserId: auth.user.id,
          entityType: 'User',
          entityId: user.id,
          data: { role, newAccount: temporaryPassword !== undefined },
          ip: auth.ip,
        },
        tx,
      );
      return { userId: user.id, temporaryPassword: temporaryPassword ?? null };
    });
  }

  async update(auth: CompanyAuthContext, userId: string, input: UpdateMember) {
    if (userId === auth.user.id) throw forbidden('member.cannotChangeSelf');

    await this.prisma.$transaction(async (tx) => {
      const member = await tx.membership.findUnique({
        where: { userId_companyId: { userId, companyId: auth.company.id } },
      });
      if (!member) throw notFound('member.notFound');
      // Only owners can change owners or make someone an owner.
      if (member.role === 'OWNER') assertMayGrant(auth, 'OWNER');
      if (input.role) assertMayGrant(auth, input.role);

      const losingOwner =
        member.role === 'OWNER' &&
        member.isActive &&
        ((input.role !== undefined && input.role !== 'OWNER') || input.isActive === false);
      if (losingOwner) {
        const owners = await tx.membership.count({
          where: { companyId: auth.company.id, role: 'OWNER', isActive: true },
        });
        if (owners <= 1) throw badRequest('member.lastOwner');
      }

      await tx.membership.update({
        where: { userId_companyId: { userId, companyId: auth.company.id } },
        data: { role: input.role, isActive: input.isActive },
      });
      if (input.isActive === false) {
        // Deactivated: they can't keep working in this company from an open session.
        await tx.session.updateMany({
          where: { userId, activeCompanyId: auth.company.id },
          data: { activeCompanyId: null },
        });
      }
      await this.audit.record(
        {
          action: 'member.update',
          companyId: auth.company.id,
          actorUserId: auth.user.id,
          entityType: 'User',
          entityId: userId,
          data: diff({ role: member.role, isActive: member.isActive }, input),
          ip: auth.ip,
        },
        tx,
      );
    });
  }

  /**
   * Issues a new temporary password and signs the person out everywhere. Only allowed
   * for accounts that belong to this company alone: otherwise one company's admin
   * could take over an account that also has access to another company.
   */
  async resetPassword(auth: CompanyAuthContext, userId: string) {
    if (userId === auth.user.id) throw forbidden('member.cannotChangeSelf');

    return this.prisma.$transaction(async (tx) => {
      const member = await tx.membership.findUnique({
        where: { userId_companyId: { userId, companyId: auth.company.id } },
        include: { user: { include: { _count: { select: { memberships: true } } } } },
      });
      if (!member) throw notFound('member.notFound');
      if (member.role === 'OWNER') assertMayGrant(auth, 'OWNER');
      if (member.user._count.memberships > 1 || member.user.isPlatformAdmin) {
        throw forbidden('member.sharedAccount');
      }

      const temporaryPassword = generateTemporaryPassword();
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true },
      });
      await tx.session.deleteMany({ where: { userId } });
      await this.audit.record(
        {
          action: 'member.passwordReset',
          companyId: auth.company.id,
          actorUserId: auth.user.id,
          entityType: 'User',
          entityId: userId,
          ip: auth.ip,
        },
        tx,
      );
      return { temporaryPassword };
    });
  }
}

/** Admins can manage everyone except owners; only owners can grant or change OWNER. */
function assertMayGrant(auth: CompanyAuthContext, role: Role) {
  if (role === 'OWNER' && auth.company.role !== 'OWNER') throw forbidden('member.onlyOwnerManagesOwners');
}
