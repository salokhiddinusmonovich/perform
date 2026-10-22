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
  /** Set while the person hasn't accepted: they have an account elsewhere and were invited. */
  invitation: 'pending' | 'declined' | null;
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
    return rows.map((m) => {
      // Until the person accepts, show only what this company typed: the account's own
      // name and contacts may have been given to another company.
      const accepted = m.acceptedAt !== null;
      return {
        userId: m.userId,
        fullName: accepted ? m.user.fullName : (m.invitedName ?? ''),
        email: accepted ? m.user.email : m.invitedEmail,
        phone: accepted ? m.user.phone : m.invitedPhone,
        role: m.role,
        isActive: m.isActive,
        invitation: accepted ? null : m.declinedAt ? 'declined' : 'pending',
        lastLoginAt: accepted ? m.user.lastLoginAt : null,
        mustChangePassword: accepted && m.user.mustChangePassword,
        createdAt: m.createdAt,
      };
    });
  }

  /**
   * Adds a person to the company. Someone without an account gets one with a temporary
   * password and is a member right away. Someone who already has an account (from
   * another company) is only invited: they get access after they accept.
   */
  async create(auth: CompanyAuthContext, input: CreateMember) {
    assertMayGrant(auth, input.role);
    const { role, ...contact } = input;

    return this.prisma.$transaction(async (tx) => {
      const { user, temporaryPassword } = await this.accounts.findOrCreate(tx, contact);
      const newAccount = temporaryPassword !== undefined;
      const where = { userId_companyId: { userId: user.id, companyId: auth.company.id } };
      const existing = await tx.membership.findUnique({ where });
      // An invitation that was declined or cancelled may be sent again; anything else is a duplicate.
      const reinvite = existing && existing.acceptedAt === null && (existing.declinedAt !== null || !existing.isActive);
      if (existing && !reinvite) {
        throw conflict('member.alreadyExists');
      }

      const invited = {
        invitedName: contact.fullName,
        invitedEmail: contact.email ?? null,
        invitedPhone: contact.phone ?? null,
      };
      if (existing) {
        await tx.membership.update({ where, data: { role, isActive: true, declinedAt: null, ...invited } });
      } else {
        await tx.membership.create({
          data: {
            userId: user.id,
            companyId: auth.company.id,
            role,
            ...invited,
            acceptedAt: newAccount ? new Date() : null,
          },
        });
      }
      await this.audit.record(
        {
          action: newAccount ? 'member.add' : 'member.invite',
          companyId: auth.company.id,
          actorUserId: auth.user.id,
          entityType: 'User',
          entityId: user.id,
          data: { role, newAccount },
          ip: auth.ip,
        },
        tx,
      );
      return { userId: user.id, temporaryPassword: temporaryPassword ?? null, invited: !newAccount };
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
        member.acceptedAt !== null &&
        ((input.role !== undefined && input.role !== 'OWNER') || input.isActive === false);
      if (losingOwner) {
        const owners = await tx.membership.count({
          where: { companyId: auth.company.id, role: 'OWNER', isActive: true, acceptedAt: { not: null } },
        });
        if (owners <= 1) throw badRequest('member.lastOwner');
      }

      // Site and team assignments mean something different for each role, so a new
      // role starts without any; they are assigned again on the Sites page.
      const roleChanged = input.role !== undefined && input.role !== member.role;
      const cleared = roleChanged
        ? {
            siteIds: (await tx.memberSite.findMany({ where: { userId, companyId: auth.company.id } })).map((s) => s.siteId),
            teamIds: (await tx.memberTeam.findMany({ where: { userId, companyId: auth.company.id } })).map((t) => t.teamId),
          }
        : null;
      if (roleChanged) {
        await tx.memberSite.deleteMany({ where: { userId, companyId: auth.company.id } });
        await tx.memberTeam.deleteMany({ where: { userId, companyId: auth.company.id } });
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
          data: {
            ...diff({ role: member.role, isActive: member.isActive }, input),
            ...(cleared && (cleared.siteIds.length || cleared.teamIds.length) ? { clearedScopes: cleared } : {}),
          },
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
      // An invited person's account isn't this company's: only they manage its password.
      if (member.acceptedAt === null) throw forbidden('member.invitationNotAccepted');
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
