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
