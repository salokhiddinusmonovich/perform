import type { DayKind, DayStatus } from '@puantaj/payroll';
import type { CodeStatus, EntryRole, TimesheetEntryInput, YearMonth } from '@puantaj/schemas';
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
  /** Part of an Excel import: changed by owners and admins, or by importing the month again */
  imported: boolean;
  updatedBy: { fullName: string };
  updatedAt: string;
}

/** One worker at one team of the site (or no team). */
export interface TimesheetRow {
  worker: WorkerName;
  teamId: string | null;
  teamName: string | null;
  /** The placement's department; null: none */
  departmentId: string | null;
  /** Spans the worker is employed in the month, at any site */
  employed: { from: string; until: string | null }[];
  /** Hours for this worker-month come from monthly totals */
  hasMonthlyTotals: boolean;
  /** Hours for this worker-month come from an Excel import */
  hasImportedHours: boolean;
  /** Days of the imported month changed by hand since the import, cleared days too */
  editedDays: string[];
  canEnter: boolean;
  entries: TimesheetEntryItem[];
}

export interface TimesheetMonth {
  year: number;
  month: number;
  site: { id: string; name: string; isActive: boolean };
  locked: boolean;
  /** This month's plan has the Timesheet module; without it no hours are entered */
  timesheetModule: boolean;
  /** null while no pay rules are set for the month */
  calendar: { date: string; kind: DayKind }[] | null;
  rows: TimesheetRow[];
}

export interface TimesheetSettingsItem {
  entryRoles: EntryRole[];
  setBy: { fullName: string } | null;
  setAt: string | null;
}

/** One of the company's own codes (apps/api/src/timesheet/timesheet-codes.service.ts). */
export interface TimesheetCodeItem {
  code: string;
  status: CodeStatus;
  /** The code the grid shows for its status */
  inGrid: boolean;
}

export const TIMESHEET_KEY = ['timesheet'] as const;
export const TIMESHEET_SETTINGS_KEY = ['timesheet', 'settings'] as const;
export const TIMESHEET_CODES_KEY = ['timesheet', 'codes'] as const;

export const timesheetKey = ({ year, month }: YearMonth, siteId: string) => [...TIMESHEET_KEY, year, month, siteId] as const;

export function useTimesheet(month: YearMonth, siteId: string | null) {
  return useQuery({
    queryKey: timesheetKey(month, siteId ?? ''),
    queryFn: () => api.get<TimesheetMonth>(`/timesheet/${month.year}/${month.month}?siteId=${siteId}`),
    enabled: siteId !== null,
  });
}

export function useTimesheetCodes() {
  return useQuery({ queryKey: TIMESHEET_CODES_KEY, queryFn: () => api.get<TimesheetCodeItem[]>('/timesheet-codes') });
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

/** Stands for "no team" where a team is picked by id. */
export const NO_TEAM = 'none';

/** The team a row is filtered by: its id, or NO_TEAM. */
export const rowTeamKey = (row: Pick<TimesheetRow, 'teamId'>) => row.teamId ?? NO_TEAM;

/** The teams the rows belong to, by name, once each. Rows without a team come last, with a null name. */
export function rowTeams(rows: Pick<TimesheetRow, 'teamId' | 'teamName'>[]): { key: string; name: string | null }[] {
  const teams = new Map(rows.map((r) => [rowTeamKey(r), r.teamName]));
  return [...teams]
    .map(([key, name]) => ({ key, name }))
    .sort((a, b) => (a.name === null ? 1 : b.name === null ? -1 : a.name.localeCompare(b.name)));
}

/** The row's worker is employed on this day (at any site). */
export const employedOn = (row: Pick<TimesheetRow, 'employed'>, day: string) =>
  row.employed.some((s) => s.from <= day && (s.until === null || s.until >= day));
