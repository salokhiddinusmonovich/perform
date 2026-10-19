import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

const SESSION_DAYS = 14;
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

@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  /** Creates a session and returns the raw token for the cookie (only its hash is stored). */
  async create(params: { userId: string; activeCompanyId: string | null; ip?: string; userAgent?: string }) {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.session.create({
      data: {
        tokenHash: hashToken(token),
        userId: params.userId,
        activeCompanyId: params.activeCompanyId,
        ip: params.ip,
        userAgent: params.userAgent?.slice(0, 300),
        expiresAt: new Date(Date.now() + SESSION_DAYS * DAY_MS),
      },
    });
    return token;
  }

  /** Finds a valid session for a cookie token, extending it while it's in use. */
  async findValid(token: string) {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    if (!session) return null;
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

  async setActiveCompany(sessionId: string, companyId: string | null) {
    await this.prisma.session.update({ where: { id: sessionId }, data: { activeCompanyId: companyId } });
  }
}
