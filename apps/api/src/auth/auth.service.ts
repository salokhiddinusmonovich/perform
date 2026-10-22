import { Injectable } from '@nestjs/common';
import { parseIdentifier, type ChangePasswordInput, type LoginInput } from '@puantaj/schemas';
import { AuditService } from '../audit/audit.service';
import type { SessionKind } from '@prisma/client';
import { badRequest, forbidden, notFound, tooManyRequests, unauthorized } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthContext } from './auth.context';
import { LoginRateLimiter } from './login-rate-limiter';
import { USABLE_MEMBERSHIP } from './memberships';
import { hashPassword, verifyDummyPassword, verifyPassword } from './passwords';
import { SessionService } from './session.service';

export interface SessionView {
  id: string;
  kind: SessionKind;
  deviceName: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  /** The session this request was made with */
  current: boolean;
}

/** What the web app needs to know about the logged-in user. */
export interface Me {
  user: AuthContext['user'];
  activeCompany: AuthContext['company'];
  companies: { id: string; name: string; role: string }[];
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly limiter: LoginRateLimiter,
    private readonly audit: AuditService,
  ) {}

  /**
   * Returns the new session's token: for the cookie (BROWSER) or for the app's bearer
   * header (APP, with the device name the app sent).
   */
  async login(
    input: LoginInput,
    client: { kind: SessionKind; deviceName?: string; ip: string; userAgent?: string },
  ): Promise<string> {
    const { ip, userAgent } = client;
    const identifier = parseIdentifier(input.identifier);
    const key = identifier?.value ?? input.identifier.trim().toLowerCase();

    const wait = this.limiter.retryAfterSeconds(key, ip);
    if (wait > 0) throw tooManyRequests('auth.tooManyAttempts', wait);

    const user = identifier
      ? await this.prisma.user.findUnique({
          where: identifier.kind === 'email' ? { email: identifier.value } : { phone: identifier.value },
        })
      : null;

    // Same work and same answer whether the login is unknown, the password is wrong,
    // or the account is disabled, so none of these can be told apart from outside.
    const valid = user ? await verifyPassword(user.passwordHash, input.password) : await verifyDummyPassword(input.password);
    if (!user || !valid || !user.isActive) {
      this.limiter.recordFailure(key, ip);
      throw unauthorized('auth.invalidCredentials');
    }
    this.limiter.recordSuccess(key);

    const firstCompany = await this.prisma.membership.findFirst({
      where: { userId: user.id, ...USABLE_MEMBERSHIP },
      orderBy: { createdAt: 'asc' },
    });
    const token = await this.sessions.create({
      userId: user.id,
      activeCompanyId: firstCompany?.companyId ?? null,
      kind: client.kind,
      deviceName: client.deviceName,
      ip,
      userAgent,
    });
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.record({
      action: 'auth.login',
      actorUserId: user.id,
      entityType: 'User',
      entityId: user.id,
      data: client.kind === 'APP' ? { kind: 'APP', deviceName: client.deviceName ?? null } : {},
      ip,
    });
    return token;
  }

  async logout(auth: AuthContext) {
    await this.sessions.delete(auth.sessionId);
  }

  async me(auth: AuthContext): Promise<Me> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId: auth.user.id, ...USABLE_MEMBERSHIP },
      include: { company: { select: { id: true, name: true } } },
      orderBy: { company: { name: 'asc' } },
    });
    return {
      user: auth.user,
      activeCompany: auth.company,
      companies: memberships.map((m) => ({ id: m.company.id, name: m.company.name, role: m.role })),
    };
  }

  /** Replaces the password and signs out all the user's other sessions. */
  async changePassword(auth: AuthContext, input: ChangePasswordInput) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
    if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
      throw badRequest('validation', {
        issues: [{ path: 'currentPassword', message: 'validation.currentPasswordWrong' }],
      });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(input.newPassword), mustChangePassword: false },
      });
      await tx.session.deleteMany({ where: { userId: user.id, id: { not: auth.sessionId } } });
      await this.audit.record(
        { action: 'auth.passwordChanged', actorUserId: user.id, entityType: 'User', entityId: user.id, ip: auth.ip },
        tx,
      );
    });
  }

  /** The user's own sessions (browsers and app devices), newest use first. */
  async listSessions(auth: AuthContext): Promise<SessionView[]> {
    const rows = await this.prisma.session.findMany({
      where: { userId: auth.user.id, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
    });
    return rows.map((s) => ({
      id: s.id,
      kind: s.kind,
      deviceName: s.deviceName,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      current: s.id === auth.sessionId,
    }));
  }

  /** Logs out one of the user's own sessions, e.g. a lost phone. */
  async revokeSession(auth: AuthContext, sessionId: string) {
    const { count } = await this.prisma.session.deleteMany({ where: { id: sessionId, userId: auth.user.id } });
    if (count === 0) throw notFound('session.notFound');
    await this.audit.record({
      action: 'auth.sessionRevoked',
      actorUserId: auth.user.id,
      entityType: 'Session',
      entityId: sessionId,
      ip: auth.ip,
    });
  }

  async switchCompany(auth: AuthContext, companyId: string) {
    const membership = await this.prisma.membership.findFirst({
      where: { userId: auth.user.id, companyId, ...USABLE_MEMBERSHIP },
    });
    if (!membership) throw forbidden('company.notMember');
    await this.sessions.setActiveCompany(auth.sessionId, companyId);
  }
}
