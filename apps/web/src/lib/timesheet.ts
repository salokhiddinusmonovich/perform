import type { DayKind, DayStatus } from '@puantaj/payroll';
import type { EntryRole, EntryStatus, TimesheetEntryInput, YearMonth } from '@puantaj/schemas';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { WorkerName } from './payroll';

// Daily hours as the API returns them (apps/api/src/timesheet).

export interface TimesheetEntryItem {
  id: string;
  date: string;
  status: DayStatus;
  /** Decimal string; "0" unless WORKED */
  hours: string;
  note: string | null;
  /** Sent back with a change or removal: a stale version is refused. */
  version: number;
  updatedBy: { fullName: string };
  updatedAt: string;
}

/** One worker at one team of the site (or no team). */
export interface TimesheetRow {
  worker: WorkerName;
  teamId: string | null;
  teamName: string | null;
  /** Spans the worker is employed in the month, at any site */
  employed: { from: string; until: string | null }[];
  /** Hours for this worker-month come from monthly totals */
  hasMonthlyTotals: boolean;
  canEnter: boolean;
  entries: TimesheetEntryItem[];
}

export interface TimesheetMonth {
  year: number;
  month: number;
  site: { id: string; name: string; isActive: boolean };
  locked: boolean;
  /** Today in the company's time zone */
  today: string;
  /** null while no pay rules are set for the month */
  calendar: { date: string; kind: DayKind }[] | null;
  rows: TimesheetRow[];
}

export interface TimesheetSettingsItem {
  entryRoles: EntryRole[];
  setBy: { fullName: string } | null;
  setAt: string | null;
}

/** Statuses entered with a letter code (hours are typed as a number). */
export const CODE_STATUSES = ['ABSENT', 'LEAVE', 'SICK', 'TRAVEL'] as const satisfies readonly EntryStatus[];

export const TIMESHEET_KEY = ['timesheet'] as const;
export const TIMESHEET_SETTINGS_KEY = ['timesheet', 'settings'] as const;

export const timesheetKey = ({ year, month }: YearMonth, siteId: string) => [...TIMESHEET_KEY, year, month, siteId] as const;

export function useTimesheet(month: YearMonth, siteId: string | null) {
  return useQuery({
    queryKey: timesheetKey(month, siteId ?? ''),
    queryFn: () => api.get<TimesheetMonth>(`/timesheet/${month.year}/${month.month}?siteId=${siteId}`),
    enabled: siteId !== null,
  });
}

export function useTimesheetSettings() {
  return useQuery({ queryKey: TIMESHEET_SETTINGS_KEY, queryFn: () => api.get<TimesheetSettingsItem>('/timesheet/settings') });
}

/** Creates or changes an entry by its id (made here for a new one). */
export const putEntry = (id: string, body: TimesheetEntryInput) => api.put<TimesheetEntryItem>(`/timesheet/entries/${id}`, body);

export const deleteEntry = (id: string, version: number) => api.delete(`/timesheet/entries/${id}?version=${version}`);

/** Every day of a month, "YYYY-MM-DD". */
export function monthDays({ year, month }: YearMonth): string[] {
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  return Array.from({ length: count }, (_, i) => `${year}-${mm}-${String(i + 1).padStart(2, '0')}`);
}

/** The row's worker is employed on this day (at any site). */
export const employedOn = (row: Pick<TimesheetRow, 'employed'>, day: string) =>
  row.employed.some((s) => s.from <= day && (s.until === null || s.until >= day));
