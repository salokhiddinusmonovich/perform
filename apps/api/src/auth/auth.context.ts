import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '@prisma/client';
import type { Request } from 'express';
import { forbidden, unauthorized } from '../common/api-error';
import type { SubscriptionState } from '../platform/subscription';

export interface AuthUser {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  locale: string;
  isPlatformAdmin: boolean;
  mustChangePassword: boolean;
}

export interface ActiveCompany {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  role: Role;
  /**
   * Modules open to this company now (Payroll always): Timesheet while this month's plan
   * has it, or an earlier month that had it isn't locked yet (platform/company-plan.ts).
   */
  modules: CompanyModule[];
  /** The company uses departments (AGENTS.md: Departments): placements need one, and they are shown. */
  departments: boolean;
  /** The company uses firms (AGENTS.md: Firms): placements need one, and salaries and payslips go per firm. */
  firms: boolean;
  /** Sites a project manager or timekeeper works on (MemberSite); null for other roles. */
  siteIds: string[] | null;
  /** Teams a foreman leads (MemberTeam); null for other roles. */
  teamIds: string[] | null;
  /** Plan and paid-until date; READ_ONLY refuses every change (AGENTS.md: Subscriptions). */
  subscription: SubscriptionState;
}

/** The platform admin who is logged in as `user` (AGENTS.md: Platform admin). */
export interface Impersonator {
  id: string;
  fullName: string;
  /** When the impersonation ends by itself */
  endsAt: Date;
}

/** Feature modules (AGENTS.md: Modules). Every company has PAYROLL; TIMESHEET is optional. */
export const COMPANY_MODULES = ['PAYROLL', 'TIMESHEET'] as const;
export type CompanyModule = (typeof COMPANY_MODULES)[number];

export interface AuthContext {
  sessionId: string;
  /** Who the request acts as: the impersonated user while a platform admin is logged in as them. */
  user: AuthUser;
  /** The platform admin acting as `user`, or null for a normal login. */
  impersonator: Impersonator | null;
  /** null when the user has no active membership (e.g. a platform admin only) */
  company: ActiveCompany | null;
  ip: string;
}

export interface CompanyAuthContext extends AuthContext {
  company: ActiveCompany;
}

export type AuthedRequest = Request & { auth?: AuthContext };

export const IS_PUBLIC = 'auth:public';
export const OPTIONAL_AUTH = 'auth:optional';
export const ALLOW_TEMPORARY_PASSWORD = 'auth:allowTemporaryPassword';
export const PLATFORM_ADMIN_ONLY = 'auth:platformAdmin';
export const ROLES = 'auth:roles';
export const MODULE = 'auth:module';
export const NOT_WHILE_IMPERSONATING = 'auth:notWhileImpersonating';

/** No login needed (health check, login itself). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Works logged in or not; use @MaybeAuth() to read the user (or null). */
export const OptionalAuth = () => SetMetadata(OPTIONAL_AUTH, true);
/** Reachable while the user still has to replace a temporary password. */
export const AllowTemporaryPassword = () => SetMetadata(ALLOW_TEMPORARY_PASSWORD, true);
/** Only for platform admins (the product operator). */
export const PlatformAdminOnly = () => SetMetadata(PLATFORM_ADMIN_ONLY, true);
/**
 * Only the real person may do this (their password, sessions, invitations): refused with
 * `impersonation.notAllowed` while a platform admin is logged in as them.
 */
export const NotWhileImpersonating = () => SetMetadata(NOT_WHILE_IMPERSONATING, true);
/** Needs an active company where the user has one of these roles. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);
/**
 * The module a company route belongs to (AGENTS.md: Modules). Required on every route
 * with @Roles(); the route is refused with `module.disabled` when the company doesn't
 * have the module. Payroll is every company's base module, so company settings and
 * users belong to it too.
 */
export const ForModule = (module: CompanyModule) => SetMetadata(MODULE, module);

/** The logged-in user's context. */
export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const auth = ctx.switchToHttp().getRequest<AuthedRequest>().auth;
  if (!auth) throw unauthorized();
  return auth;
});

/** The logged-in user's context, or null on an @OptionalAuth() route without login. */
export const MaybeAuth = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthContext | null => ctx.switchToHttp().getRequest<AuthedRequest>().auth ?? null,
);

/** The logged-in user's context, guaranteed to have an active company. */
export const CompanyAuth = createParamDecorator((_: unknown, ctx: ExecutionContext): CompanyAuthContext => {
  const auth = ctx.switchToHttp().getRequest<AuthedRequest>().auth;
  if (!auth) throw unauthorized();
  if (!auth.company) throw forbidden('company.required');
  return auth as CompanyAuthContext;
});
