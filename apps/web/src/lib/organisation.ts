import type { EmploymentType, Role, Shift } from '@puantaj/schemas';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

// Sites, teams and workers as the API returns them (apps/api/src/organisation).

export interface StaffMember {
  userId: string;
  fullName: string;
  role: Role;
}

export interface TeamItem {
  id: string;
  siteId: string;
  name: string;
  department: string | null;
  isActive: boolean;
  foremen: StaffMember[];
  workerCount: number;
}

export interface SiteItem {
  id: string;
  name: string;
  code: string | null;
  address: string | null;
  isActive: boolean;
  staff: StaffMember[];
  teams: TeamItem[];
  workerCount: number;
}

export interface WorkerItem {
  id: string;
  lastName: string;
  firstName: string;
  patronymic: string | null;
  position: string | null;
  employmentType: EmploymentType;
  placement: {
    id: string;
    siteId: string;
    siteName: string;
    teamId: string | null;
    teamName: string | null;
    from: string;
    until: string | null;
    shift: Shift;
  } | null;
  /** null for timekeepers and foremen: the API doesn't send it to them */
  personal: {
    pinfl: string | null;
    birthDate: string | null;
    nationality: string | null;
    passportSeries: string | null;
    passportNumber: string | null;
    phone: string | null;
  } | null;
  /** The latest salary (it may start in a later month). null when there is none yet, or for timekeepers and foremen. */
  salary: Pick<SalaryItem, 'fromYear' | 'fromMonth' | 'monthlySalary'> | null;
}

/** A salary from a month on, newest first in a worker's history. */
export interface SalaryItem {
  id: string;
  fromYear: number;
  fromMonth: number;
  /** Decimal string, e.g. "7500000" */
  monthlySalary: string;
  reason: string | null;
  /** A newer salary from the same month corrected this one, so it never applies. */
  corrected: boolean;
  setBy: { fullName: string };
  setAt: string;
}

export const SITES_KEY = ['sites'] as const;
export const WORKERS_KEY = ['workers'] as const;

/** Sites the user can see, with their teams and staff. */
export function useSites() {
  return useQuery({ queryKey: SITES_KEY, queryFn: () => api.get<SiteItem[]>('/sites') });
}

export function useWorkers() {
  return useQuery({ queryKey: WORKERS_KEY, queryFn: () => api.get<WorkerItem[]>('/workers') });
}

export const salariesKey = (workerId: string) => [...WORKERS_KEY, workerId, 'salaries'] as const;

export function useSalaries(workerId: string) {
  return useQuery({ queryKey: salariesKey(workerId), queryFn: () => api.get<SalaryItem[]>(`/workers/${workerId}/salaries`) });
}

/** After any change to sites, teams or workers: counts and lists on both pages change. */
export function useRefreshOrganisation() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: SITES_KEY }),
      queryClient.invalidateQueries({ queryKey: WORKERS_KEY }),
    ]);
}

export const workerName = (w: Pick<WorkerItem, 'lastName' | 'firstName' | 'patronymic'>) =>
  [w.lastName, w.firstName, w.patronymic].filter(Boolean).join(' ');
