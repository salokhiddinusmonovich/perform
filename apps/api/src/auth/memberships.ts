import type { Prisma, Role } from '@prisma/client';

/**
 * A membership that gives access to its company: active, accepted (not a pending or
 * declined invitation), in an active company. The one definition used everywhere access
 * is decided (session guard, login, /me, switching company).
 */
export const USABLE_MEMBERSHIP = {
  isActive: true,
  acceptedAt: { not: null },
  company: { isActive: true },
} as const satisfies Prisma.MembershipWhereInput;

/** An invitation the person can still accept or decline. */
export const OPEN_INVITATION = {
  isActive: true,
  acceptedAt: null,
  declinedAt: null,
  company: { isActive: true },
} as const satisfies Prisma.MembershipWhereInput;

/** Roles limited to the sites they are assigned to (MemberSite). Foremen are limited to teams. */
export const SITE_SCOPED: readonly Role[] = ['PROJECT_MANAGER', 'TIMEKEEPER'];
