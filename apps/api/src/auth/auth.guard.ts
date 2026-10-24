import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import type { Response } from 'express';
import { forbidden, unauthorized } from '../common/api-error';
import { monthOfDay, todayIn } from '../common/dates';
import { planOfMonth, PLAN_HISTORY, timesheetOpen } from '../platform/company-plan';
import { subscriptionState } from '../platform/subscription';
import { PrismaService } from '../prisma/prisma.service';
import {
  ALLOW_TEMPORARY_PASSWORD,
  IS_PUBLIC,
  NOT_WHILE_IMPERSONATING,
  OPTIONAL_AUTH,
  PLATFORM_ADMIN_ONLY,
  MODULE,
  ROLES,
  type ActiveCompany,
  type CompanyModule,
  type AuthedRequest,
  type Impersonator,
} from './auth.context';
import { SITE_SCOPED, USABLE_MEMBERSHIP } from './memberships';
import { bearerToken, SESSION_COOKIE, sessionCookieOptions, SessionService, type ValidSession } from './session.service';

const SCOPE_INCLUDE = {
  company: { include: { plans: PLAN_HISTORY } },
  sites: { select: { siteId: true } },
  teams: { select: { teamId: true } },
} as const;

/** Methods that only read; anything else is a change, refused in a read-only company. */
const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * Runs on every request (registered as APP_GUARD). Everything requires a login
 * unless marked @Public() (never looks at the session) or @OptionalAuth() (runs
 * either way, with the user if there is one). Then it applies, in order:
 * temporary-password lock, @NotWhileImpersonating(), @PlatformAdminOnly(),
 * @ForModule(), @Roles() and the read-only state of an expired subscription.
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

    const impersonation = await this.impersonation(session);
    // While impersonating, the request acts as the impersonated user, in their company.
    const user = impersonation?.user ?? session.user;
    const company = impersonation
      ? await this.resolveCompany(session.id, user.id, session.impersonatedCompanyId, true)
      : await this.resolveCompany(session.id, user.id, session.activeCompanyId, false);
    const impersonator = impersonation?.impersonator ?? null;
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
      impersonator,
      company,
      ip: req.ip ?? '',
    };

    // The lock is for the person to choose their own password; an admin acting as them
    // must not, so it doesn't apply to them.
    if (
      user.mustChangePassword &&
      !impersonator &&
      !this.reflector.getAllAndOverride<boolean>(ALLOW_TEMPORARY_PASSWORD, targets)
    ) {
      throw forbidden('auth.passwordChangeRequired');
    }
    if (impersonator && this.reflector.getAllAndOverride<boolean>(NOT_WHILE_IMPERSONATING, targets)) {
      throw forbidden('impersonation.notAllowed');
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
      if (company.subscription.status === 'READ_ONLY' && !READ_METHODS.includes(req.method)) {
        throw forbidden('subscription.expired');
      }
    }
    return true;
  }

  /**
   * The running impersonation, or null. One that ran out, whose admin is no longer a
   * platform admin, or whose user can no longer be impersonated ends here, and the
   * session is the admin's own again.
   */
  private async impersonation(session: ValidSession) {
    const target = session.impersonatedUser;
    const endsAt = session.impersonationEndsAt;
    if (!target || !endsAt) return null;
    const valid = endsAt.getTime() > Date.now() && session.user.isPlatformAdmin && target.isActive && !target.isPlatformAdmin;
    if (!valid) {
      await this.sessions.endImpersonation(session.id);
      return null;
    }
    const impersonator: Impersonator = { id: session.user.id, fullName: session.user.fullName, endsAt };
    return { user: target, impersonator };
  }

  /**
   * The session's company, if the user is still an active member of an active company.
   * Otherwise falls back to the user's first such company (and remembers it), or null.
   * While impersonating, it is the impersonated user's company, kept apart from the
   * admin's own.
   */
  private async resolveCompany(
    sessionId: string,
    userId: string,
    activeCompanyId: string | null,
    impersonating: boolean,
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
    if (companyId !== activeCompanyId) await this.sessions.setActiveCompany(sessionId, companyId, impersonating);
    if (!membership) return null;

    const { company } = membership;
    const today = todayIn(company.timezone);
    const plan = planOfMonth(company.plans, monthOfDay(today));
    const timesheet = await timesheetOpen(this.prisma, company.id, company.plans, today);
    return {
      id: company.id,
      name: company.name,
      currency: company.currency,
      timezone: company.timezone,
      role: membership.role,
      modules: timesheet ? ['PAYROLL', 'TIMESHEET'] : ['PAYROLL'],
      siteIds: SITE_SCOPED.includes(membership.role) ? membership.sites.map((s) => s.siteId) : null,
      teamIds: membership.role === 'FOREMAN' ? membership.teams.map((t) => t.teamId) : null,
      subscription: subscriptionState({ paidThrough: company.paidThrough, plan }, today),
    };
  }
}
