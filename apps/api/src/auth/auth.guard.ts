import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import type { Response } from 'express';
import { forbidden, unauthorized } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import {
  ALLOW_TEMPORARY_PASSWORD,
  IS_PUBLIC,
  OPTIONAL_AUTH,
  PLATFORM_ADMIN_ONLY,
  ROLES,
  type ActiveCompany,
  type AuthedRequest,
} from './auth.context';
import { USABLE_MEMBERSHIP } from './memberships';
import { SESSION_COOKIE, sessionCookieOptions, SessionService } from './session.service';

/**
 * Runs on every request (registered as APP_GUARD). Everything requires a login
 * unless marked @Public() (never looks at the session) or @OptionalAuth() (runs
 * either way, with the user if there is one). Then it applies, in order:
 * temporary-password lock, @PlatformAdminOnly(), @Roles().
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    const session = typeof token === 'string' && token ? await this.sessions.findValid(token) : null;

    if (!session || !session.user.isActive) {
      if (session) await this.sessions.delete(session.id);
      if (token) res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined });
      if (this.reflector.getAllAndOverride<boolean>(OPTIONAL_AUTH, targets)) return true;
      throw unauthorized();
    }

    const company = await this.resolveCompany(session.id, session.userId, session.activeCompanyId);
    const { user } = session;
    req.auth = {
      sessionId: session.id,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        locale: user.locale,
        isPlatformAdmin: user.isPlatformAdmin,
        mustChangePassword: user.mustChangePassword,
      },
      company,
      ip: req.ip ?? '',
    };

    if (user.mustChangePassword && !this.reflector.getAllAndOverride<boolean>(ALLOW_TEMPORARY_PASSWORD, targets)) {
      throw forbidden('auth.passwordChangeRequired');
    }
    if (this.reflector.getAllAndOverride<boolean>(PLATFORM_ADMIN_ONLY, targets) && !user.isPlatformAdmin) {
      throw forbidden();
    }
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
    if (roles) {
      if (!company) throw forbidden('company.required');
      if (!roles.includes(company.role)) throw forbidden();
    }
    return true;
  }

  /**
   * The session's company, if the user is still an active member of an active company.
   * Otherwise falls back to the user's first such company (and remembers it), or null.
   */
  private async resolveCompany(
    sessionId: string,
    userId: string,
    activeCompanyId: string | null,
  ): Promise<ActiveCompany | null> {
    const usable = { userId, ...USABLE_MEMBERSHIP };
    const membership =
      (activeCompanyId &&
        (await this.prisma.membership.findFirst({
          where: { ...usable, companyId: activeCompanyId },
          include: { company: true },
        }))) ||
      (await this.prisma.membership.findFirst({
        where: usable,
        include: { company: true },
        orderBy: { createdAt: 'asc' },
      }));

    const companyId = membership?.companyId ?? null;
    if (companyId !== activeCompanyId) await this.sessions.setActiveCompany(sessionId, companyId);
    if (!membership) return null;

    const { company } = membership;
    return {
      id: company.id,
      name: company.name,
      currency: company.currency,
      timezone: company.timezone,
      role: membership.role,
      siteId: membership.siteId,
    };
  }
}
