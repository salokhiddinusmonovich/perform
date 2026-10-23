import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Role } from '@puantaj/schemas';
import { api } from './api';

export interface Me {
  user: {
    id: string;
    fullName: string;
    email: string | null;
    phone: string | null;
    locale: string;
    isPlatformAdmin: boolean;
    mustChangePassword: boolean;
  };
  activeCompany: {
    id: string;
    name: string;
    currency: string;
    timezone: string;
    role: Role;
    /** PAYROLL always; TIMESHEET when the company has it */
    modules: ('PAYROLL' | 'TIMESHEET')[];
    /** Sites a project manager or timekeeper works on; null for other roles */
    siteIds: string[] | null;
    /** Teams a foreman leads; null for other roles */
    teamIds: string[] | null;
    subscription: Subscription;
  } | null;
  companies: { id: string; name: string; role: Role }[];
  /** Set while a platform admin is logged in as this user */
  impersonation: { by: string; endsAt: string } | null;
}

/**
 * NONE: no paid-until date (never expires). GRACE: unpaid, still working (14 days).
 * READ_ONLY: the grace period is over; nothing can be changed.
 */
export interface Subscription {
  status: 'NONE' | 'ACTIVE' | 'GRACE' | 'READ_ONLY';
  planName: string | null;
  paidUntil: string | null;
  graceEndsOn: string | null;
}

export const ME_KEY = ['auth', 'me'] as const;

/** The logged-in user, or null when not logged in (the API answers null, not 401). */
export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: () => api.get<Me | null>('/auth/me'),
    staleTime: 5 * 60_000,
  });
}

/** After login, logout or switching company: forget all cached data and reload "me". */
export function useResetSession() {
  const queryClient = useQueryClient();
  return async () => {
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_KEY[0] });
    await queryClient.invalidateQueries({ queryKey: ME_KEY });
  };
}

/** The product operator: manages companies, users and plans. */
export function isPlatformAdmin(me: Me | null | undefined): boolean {
  return me?.user.isPlatformAdmin === true;
}

/** Can manage the active company's settings and users. */
export function canManageCompany(me: Me | null | undefined): boolean {
  return me?.activeCompany?.role === 'OWNER' || me?.activeCompany?.role === 'ADMIN';
}

/** Can see pay rules, holidays and working days, and override working days. Changing rules and holidays is canManageCompany. */
export function canViewPayRules(me: Me | null | undefined): boolean {
  const role = me?.activeCompany?.role;
  return role === 'OWNER' || role === 'ADMIN' || role === 'ACCOUNTANT';
}

/** Can add workers and change them, and manage teams (project managers: on their own sites; the API checks which). */
export function canManageWorkers(me: Me | null | undefined): boolean {
  const role = me?.activeCompany?.role;
  return role === 'OWNER' || role === 'ADMIN' || role === 'PROJECT_MANAGER';
}

/** Sees workers' personal data. Timekeepers and foremen don't; the API never sends it to them. */
export function seesPersonalData(me: Me | null | undefined): boolean {
  const role = me?.activeCompany?.role;
  return role !== undefined && role !== 'TIMEKEEPER' && role !== 'FOREMAN';
}

/** Sees salaries and pay. Timekeepers and foremen don't; the API never sends them. */
export function seesPay(me: Me | null | undefined): boolean {
  const role = me?.activeCompany?.role;
  return role !== undefined && role !== 'TIMEKEEPER' && role !== 'FOREMAN';
}

/** Can add salaries (only ever added, never edited). Project managers only view them. */
export function canAddSalaries(me: Me | null | undefined): boolean {
  const role = me?.activeCompany?.role;
  return role === 'OWNER' || role === 'ADMIN' || role === 'ACCOUNTANT';
}

/** Any member of the active company (sites and workers are shown to everyone within their scope). */
export function inCompany(me: Me | null | undefined): boolean {
  return Boolean(me?.activeCompany);
}
