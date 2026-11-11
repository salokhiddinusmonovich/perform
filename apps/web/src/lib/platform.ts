import type { AuditQueryInput, Role } from '@puantaj/schemas';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { Subscription } from './auth';

// Companies, accounts and plans as the platform API returns them (apps/api/src/platform).

/** Plan prices and subscription payments are in soʻm. */
export const PLATFORM_CURRENCY = 'UZS';

export const PLATFORM_KEY = ['platform'] as const;
export const COMPANIES_KEY = [...PLATFORM_KEY, 'companies'] as const;
export const USERS_KEY = [...PLATFORM_KEY, 'users'] as const;
export const PLANS_KEY = [...PLATFORM_KEY, 'plans'] as const;

export interface CompanyRow {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  isActive: boolean;
  createdAt: string;
  memberCount: number;
  owners: { fullName: string; email: string | null; phone: string | null }[];
  /** This month's plan; null for a company from before plans */
  plan: PlanSummary | null;
  /** A change that starts on the 1st of next month ("YYYY-MM-01"), or null */
  nextPlan: (PlanSummary & { fromMonth: string }) | null;
  subscription: Subscription;
  /** Workers with a placement this month */
  activeWorkers: number;
}

export interface PlanSummary {
  id: string;
  name: string;
  maxActiveWorkers: number;
  timesheetModule: boolean;
}

export interface PlanRow {
  id: string;
  name: string;
  /** Decimal string, soʻm */
  monthlyPrice: string;
  maxActiveWorkers: number;
  timesheetModule: boolean;
  /** false = archived */
  isActive: boolean;
  companyCount: number;
  /** Some company has had it: its price, worker limit and modules are fixed */
  inUse: boolean;
}

export interface UserRow {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  isPlatformAdmin: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  memberships: {
    companyId: string;
    companyName: string;
    role: Role;
    isActive: boolean;
    invitation: 'pending' | 'declined' | null;
  }[];
}

export interface PaymentRow {
  id: string;
  /** Decimal string, soʻm */
  amount: string;
  paidOn: string;
  /** "YYYY-MM-01" */
  paidThrough: string;
  note: string | null;
  recordedBy: string;
  createdAt: string;
}

export function useCompanies(enabled = true) {
  return useQuery({ queryKey: COMPANIES_KEY, queryFn: () => api.get<CompanyRow[]>('/platform/companies'), enabled });
}

export function usePlans(enabled = true) {
  return useQuery({ queryKey: PLANS_KEY, queryFn: () => api.get<PlanRow[]>('/platform/plans'), enabled });
}

export function usePlatformUsers(enabled = true) {
  return useQuery({ queryKey: USERS_KEY, queryFn: () => api.get<UserRow[]>('/platform/users'), enabled });
}

export const AUDIT_KEY = [...PLATFORM_KEY, 'audit'] as const;

/** One audit entry, as `GET /platform/audit` returns it. */
export interface AuditEntryRow {
  id: string;
  createdAt: string;
  /** An `AuditAction`, or an older code the app no longer records */
  action: string;
  company: { id: string; name: string } | null;
  /** null for actions without a session (e.g. the command line) */
  actor: { id: string; fullName: string } | null;
  /** The platform admin who acted as `actor` (impersonation) */
  impersonator: { id: string; fullName: string } | null;
  entityType: string | null;
  entityId: string | null;
  /** Changed fields ({ field: { from, to } }) or other details */
  data: unknown;
  ip: string | null;
}

interface AuditPage {
  entries: AuditEntryRow[];
  nextCursor: string | null;
}

/** The audit trail, newest first, a page at a time ("Load older" fetches the next). */
export function useAuditLog(query: Omit<AuditQueryInput, 'before'>) {
  return useInfiniteQuery({
    queryKey: [...AUDIT_KEY, query],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries({ ...query, before: pageParam ?? undefined })) {
        if (value !== undefined && value !== '') params.set(key, String(value));
      }
      return api.get<AuditPage>(`/platform/audit?${params}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
}
