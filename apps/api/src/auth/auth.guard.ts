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
  MODULE,
  ROLES,
  type ActiveCompany,
  type CompanyModule,
  type AuthedRequest,
} from './auth.context';
import { SITE_SCOPED, USABLE_MEMBERSHIP } from './memberships';

const SCOPE_INCLUDE = {
  company: true,
  sites: { select: { siteId: true } },
  teams: { select: { teamId: true } },
} as const;
import { bearerToken, SESSION_COOKIE, sessionCookieOptions, SessionService } from './session.service';

/**
 * Runs on every request (registered as APP_GUARD). Everything requires a login
 * unless marked @Public() (never looks at the session) or @OptionalAuth() (runs
 * either way, with the user if there is one). Then it applies, in order:
 * temporary-password lock, @PlatformAdminOnly(), @ForModule() and @Roles().
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
    // The app sends its token as a bearer header; the browser as a cookie. A request
    // with a bearer header is authenticated by it alone.
    const bearer = bearerToken(req);
    const cookie: unknown = req.cookies?.[SESSION_COOKIE];
    const token = bearer ?? (typeof cookie === 'string' && cookie ? cookie : null);
    const session = token ? await this.sessions.findValid(token, bearer ? 'APP' : 'BROWSER') : null;

    if (!session || !session.user.isActive) {
      if (session) await this.sessions.delete(session.id);
      if (!bearer && token) res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined });
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
      const module = this.reflector.getAllAndOverride<CompanyModule | undefined>(MODULE, targets);
      // A programming mistake, not a user error: fail loudly so tests catch it.
      if (!module) throw new Error(`${ctx.getClass().name}.${ctx.getHandler().name} has @Roles() but no @ForModule()`);
      if (!company) throw forbidden('company.required');
      if (!company.modules.includes(module)) throw forbidden('module.disabled');
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
          include: SCOPE_INCLUDE,
        }))) ||
      (await this.prisma.membership.findFirst({
        where: usable,
        include: SCOPE_INCLUDE,
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
      modules: company.timesheetModule ? ['PAYROLL', 'TIMESHEET'] : ['PAYROLL'],
      siteIds: SITE_SCOPED.includes(membership.role) ? membership.sites.map((s) => s.siteId) : null,
      teamIds: membership.role === 'FOREMAN' ? membership.teams.map((t) => t.teamId) : null,
    };
  }
}
