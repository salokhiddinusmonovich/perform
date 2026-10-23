import type { Prisma, Role } from '@prisma/client';
import type { CompanyAuthContext } from '../auth/auth.context';
import { forbidden } from '../common/api-error';

// Who sees and manages which sites, teams and workers (AGENTS.md: Roles, Hour entry).
// The one place these rules live; services call these, never check roles themselves.
// - Owners, admins and accountants see everything; accountants only look.
// - Project managers and timekeepers see their assigned sites (MemberSite); project
//   managers also manage teams, workers and timekeepers/foremen there.
// - Foremen see their own teams (MemberTeam).
// Combine the visible…() filters with other conditions through AND, never by spreading:
// a spread `id` would replace the filter's own \`id\` condition and widen the scope.

/** Roles that never get workers' personal data or pay (the API leaves the fields out). */
const FIELD_ROLES: readonly Role[] = ['TIMEKEEPER', 'FOREMAN'];

export function seesPersonalData(auth: CompanyAuthContext): boolean {
  return !FIELD_ROLES.includes(auth.company.role);
}

/** Salaries and pay amounts: everyone but timekeepers and foremen (project managers for now too). */
export function seesPay(auth: CompanyAuthContext): boolean {
  return !FIELD_ROLES.includes(auth.company.role);
}

/** Owners and admins manage the whole company: sites, project managers, everything below. */
export function isCompanyManager(auth: CompanyAuthContext): boolean {
  return auth.company.role === 'OWNER' || auth.company.role === 'ADMIN';
}

/** Sites the caller can see. */
export function visibleSites(auth: CompanyAuthContext): Prisma.SiteWhereInput {
  const { id: companyId, siteIds, teamIds } = auth.company;
  if (siteIds) return { companyId, id: { in: siteIds } };
  if (teamIds) return { companyId, teams: { some: { id: { in: teamIds } } } };
  return { companyId };
}

/** Teams the caller can see. */
export function visibleTeams(auth: CompanyAuthContext): Prisma.TeamWhereInput {
  const { id: companyId, siteIds, teamIds } = auth.company;
  if (siteIds) return { companyId, siteId: { in: siteIds } };
  if (teamIds) return { companyId, id: { in: teamIds } };
  return { companyId };
}

/** Can the caller see a placement on this site and team? */
export function seesPlacement(auth: CompanyAuthContext, siteId: string, teamId: string | null): boolean {
  const { siteIds, teamIds } = auth.company;
  if (siteIds) return siteIds.includes(siteId);
  if (teamIds) return teamId !== null && teamIds.includes(teamId);
  return true;
}

/**
 * Teams and workers on this site: owners and admins anywhere, project managers on
 * their own sites. Throws for everyone else.
 */
export function assertManagesSite(auth: CompanyAuthContext, siteId: string): void {
  if (isCompanyManager(auth)) return;
  if (auth.company.role === 'PROJECT_MANAGER' && auth.company.siteIds?.includes(siteId)) return;
  throw forbidden();
}
