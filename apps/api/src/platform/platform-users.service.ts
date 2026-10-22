import { Injectable } from '@nestjs/common';
import { Prisma, type Role } from '@prisma/client';
import type { CreatePlatformUser, PlatformMembership, UpdatePlatformUser } from '@puantaj/schemas';
import { AuditService, diff } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth.context';
import { generateTemporaryPassword, hashPassword } from '../auth/passwords';
import { SessionService } from '../auth/session.service';
import { conflict, forbidden, notFound } from '../common/api-error';
import { changeMembership } from '../company/members.service';
import { PrismaService } from '../prisma/prisma.service';

export interface PlatformUserView {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  isPlatformAdmin: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  memberships: {
    companyId: string;
    companyName: string;
    role: Role;
    isActive: boolean;
    /** pending or declined: invited by the company, not (yet) accepted */
    invitation: 'pending' | 'declined' | null;
  }[];
}

/** Every account on the platform, managed by platform admins (AGENTS.md: Platform admin). */
@Injectable()
export class PlatformUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<PlatformUserView[]> {
    const users = await this.prisma.user.findMany({
      include: { memberships: { include: { company: { select: { name: true } } } } },
      orderBy: { fullName: 'asc' },
    });
    return users.map((u) => ({
      id: u.id,
      fullName: u.fullName,
      email: u.email,
      phone: u.phone,
      isActive: u.isActive,
      isPlatformAdmin: u.isPlatformAdmin,
      mustChangePassword: u.mustChangePassword,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
      memberships: u.memberships
        .map((m) => ({
          companyId: m.companyId,
          companyName: m.company.name,
          role: m.role,
          isActive: m.isActive,
          invitation: m.acceptedAt ? null : m.declinedAt ? ('declined' as const) : ('pending' as const),
        }))
        .sort((a, b) => a.companyName.localeCompare(b.companyName)),
    }));
  }

  /** A new account with a temporary password, shown once. */
  async create(auth: AuthContext, input: CreatePlatformUser) {
    return this.prisma.$transaction(async (tx) => {
      const temporaryPassword = generateTemporaryPassword();
      const user = await tx.user
        .create({
          data: {
            fullName: input.fullName,
            email: input.email ?? null,
            phone: input.phone ?? null,
            isPlatformAdmin: input.isPlatformAdmin,
            passwordHash: await hashPassword(temporaryPassword),
            mustChangePassword: true,
          },
        })
        .catch(contactTaken);
      await this.audit.record(
        { action: 'user.create', auth, entityType: 'User', entityId: user.id, data: { isPlatformAdmin: input.isPlatformAdmin } },
        tx,
      );
      return { userId: user.id, temporaryPassword };
    });
  }

  /**
   * Changes an account. A platform admin can't deactivate themselves or drop their own
   * platform admin flag, so there is always one left. A deactivated account is signed
   * out everywhere.
   */
  async update(auth: AuthContext, userId: string, input: UpdatePlatformUser) {
    const self = userId === auth.user.id;
    if (self && (input.isActive !== undefined || input.isPlatformAdmin !== undefined)) {
      throw forbidden('platform.cannotChangeSelf');
    }
    await this.prisma.$transaction(async (tx) => {
      const before = await findUser(tx, userId);
      const after = {
        ...(input.contact && {
          fullName: input.contact.fullName,
          email: input.contact.email ?? null,
          phone: input.contact.phone ?? null,
        }),
        isActive: input.isActive,
        isPlatformAdmin: input.isPlatformAdmin,
      };
      await tx.user.update({ where: { id: userId }, data: after }).catch(contactTaken);
      if (input.isActive === false) await tx.session.deleteMany({ where: { userId } });
      await this.audit.record(
        {
          action: 'user.update',
          auth,
          entityType: 'User',
          entityId: userId,
          data: diff(
            {
              fullName: before.fullName,
              email: before.email,
              phone: before.phone,
              isActive: before.isActive,
              isPlatformAdmin: before.isPlatformAdmin,
            },
            after,
          ),
        },
        tx,
      );
    });
  }

  /** Issues a new temporary password and signs the person out everywhere. */
  async resetPassword(auth: AuthContext, userId: string) {
    // Their own password is changed the usual way, which needs the current one.
    if (userId === auth.user.id) throw forbidden('platform.cannotChangeSelf');
    return this.prisma.$transaction(async (tx) => {
      await findUser(tx, userId);
      const temporaryPassword = generateTemporaryPassword();
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true },
      });
      await tx.session.deleteMany({ where: { userId } });
      await this.audit.record({ action: 'user.passwordReset', auth, entityType: 'User', entityId: userId }, tx);
      return { temporaryPassword };
    });
  }

  /**
   * Puts a person in a company with a role, or changes their role or access there. The
   * platform admin sets people up directly, so an open invitation counts as accepted.
   * The company always keeps an owner.
   */
  async setMembership(auth: AuthContext, userId: string, companyId: string, input: PlatformMembership) {
    await this.prisma.$transaction(async (tx) => {
      await findUser(tx, userId);
      if (!(await tx.company.findUnique({ where: { id: companyId } }))) throw notFound('company.notFound');
      const where = { userId_companyId: { userId, companyId } };
      const member = await tx.membership.findUnique({ where });
      if (member?.acceptedAt) {
        await changeMembership(tx, this.audit, auth, member, input);
        return;
      }
      if (member) {
        await tx.membership.update({ where, data: { ...input, acceptedAt: new Date(), declinedAt: null } });
      } else {
        await tx.membership.create({ data: { userId, companyId, ...input, acceptedAt: new Date() } });
      }
      await this.audit.record(
        { action: 'member.add', companyId, auth, entityType: 'User', entityId: userId, data: { ...input, newAccount: false } },
        tx,
      );
    });
  }

  /**
   * Starts acting as the user, from the platform admin's current session, for at most an
   * hour (AGENTS.md: Platform admin). Not for another platform admin or a deactivated account.
   */
  async impersonate(auth: AuthContext, userId: string): Promise<{ endsAt: Date }> {
    if (userId === auth.user.id) throw forbidden('impersonation.notAllowed');
    return this.prisma.$transaction(async (tx) => {
      const user = await findUser(tx, userId);
      if (user.isPlatformAdmin) throw forbidden('impersonation.platformAdmin');
      if (!user.isActive) throw conflict('impersonation.inactiveUser');
      const endsAt = await this.sessions.startImpersonation(tx, auth.sessionId, userId);
      await this.audit.record({ action: 'impersonation.start', auth, entityType: 'User', entityId: userId }, tx);
      return { endsAt };
    });
  }
}

async function findUser(tx: Prisma.TransactionClient, userId: string) {
  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('user.notFound');
  return user;
}

/** Email and phone are logins, so each belongs to one account. */
function contactTaken(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw conflict('user.contactTaken');
  throw error;
}
