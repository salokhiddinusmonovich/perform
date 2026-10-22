import { Injectable } from '@nestjs/common';
import type { Prisma, SessionKind } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

const SESSION_DAYS = 14;
/** How long a platform admin may act as a user; never extended (AGENTS.md: Platform admin). */
export const IMPERSONATION_MINUTES = 60;
/** Extend a session at most this often, to avoid a DB write on every request. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Cookie name; "__Host-" makes browsers require HTTPS, no Domain and Path=/ in production. */
export const SESSION_COOKIE = process.env.NODE_ENV === 'production' ? '__Host-sid' : 'sid';

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_DAYS * DAY_MS,
  };
}

/** The token of an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(req: { get(name: string): string | undefined }): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '');
  return match ? match[1] : null;
}

const SESSION_INCLUDE = { user: true, impersonatedUser: true } as const;
export type ValidSession = Prisma.SessionGetPayload<{ include: typeof SESSION_INCLUDE }>;

const NO_IMPERSONATION = { impersonatedUserId: null, impersonatedCompanyId: null, impersonationEndsAt: null };

@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates a session and returns the raw token (only its hash is stored): for the
   * cookie (BROWSER) or for the app's Authorization header (APP).
   */
  async create(params: {
    userId: string;
    activeCompanyId: string | null;
    kind: SessionKind;
    deviceName?: string;
    ip?: string;
    userAgent?: string;
  }) {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.session.create({
      data: {
        tokenHash: hashToken(token),
        kind: params.kind,
        deviceName: params.deviceName,
        userId: params.userId,
        activeCompanyId: params.activeCompanyId,
        ip: params.ip,
        userAgent: params.userAgent?.slice(0, 300),
        expiresAt: new Date(Date.now() + SESSION_DAYS * DAY_MS),
      },
    });
    return token;
  }

  /**
   * Finds a valid session for a token sent the given way, extending it while it's in
   * use. A token only works the way it was issued: an app token in a cookie (or the
   * other way round) is not a session.
   */
  async findValid(token: string, kind: SessionKind): Promise<ValidSession | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: SESSION_INCLUDE,
    });
    if (!session || session.kind !== kind) return null;
    if (session.expiresAt.getTime() <= Date.now()) {
      await this.prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
      return null;
    }
    if (Date.now() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_DAYS * DAY_MS) },
      });
    }
    return session;
  }

  async delete(sessionId: string) {
    await this.prisma.session.deleteMany({ where: { id: sessionId } });
  }

  /** Signs a user out everywhere, optionally keeping the current session. */
  async deleteAllForUser(userId: string, exceptSessionId?: string) {
    await this.prisma.session.deleteMany({
      where: { userId, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    });
  }

  /** The company worked in: the user's own, or the impersonated user's while impersonating. */
  async setActiveCompany(sessionId: string, companyId: string | null, impersonating: boolean) {
    await this.prisma.session.update({
      where: { id: sessionId },
      data: impersonating ? { impersonatedCompanyId: companyId } : { activeCompanyId: companyId },
    });
  }

  /** Makes a platform admin's session act as another user; returns when it ends. */
  async startImpersonation(tx: Prisma.TransactionClient, sessionId: string, userId: string): Promise<Date> {
    const endsAt = new Date(Date.now() + IMPERSONATION_MINUTES * 60 * 1000);
    await tx.session.update({
      where: { id: sessionId },
      data: { impersonatedUserId: userId, impersonatedCompanyId: null, impersonationEndsAt: endsAt },
    });
    return endsAt;
  }

  async endImpersonation(sessionId: string, tx: Prisma.TransactionClient = this.prisma) {
    await tx.session.update({ where: { id: sessionId }, data: NO_IMPERSONATION });
  }
}
