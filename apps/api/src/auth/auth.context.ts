import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '@prisma/client';
import type { Request } from 'express';
import { forbidden, unauthorized } from '../common/api-error';

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
  /** Site the member is limited to (timekeepers/foremen); null = all sites */
  siteId: string | null;
}

export interface AuthContext {
  sessionId: string;
  user: AuthUser;
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

/** No login needed (health check, login itself). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Works logged in or not; use @MaybeAuth() to read the user (or null). */
export const OptionalAuth = () => SetMetadata(OPTIONAL_AUTH, true);
/** Reachable while the user still has to replace a temporary password. */
export const AllowTemporaryPassword = () => SetMetadata(ALLOW_TEMPORARY_PASSWORD, true);
/** Only for platform admins (the product operator). */
export const PlatformAdminOnly = () => SetMetadata(PLATFORM_ADMIN_ONLY, true);
/** Needs an active company where the user has one of these roles. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

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
