import type { MonthlyTotals, PayResult, TotalsProblem } from '@puantaj/payroll';
import type { YearMonth } from '@puantaj/schemas';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

// Monthly hours and the payroll run as the API returns them (apps/api/src/payroll).

export interface MonthlyHoursEntry extends MonthlyTotals {
  id: string;
  note: string | null;
  /** A newer entry corrected this one, so it never counts. */
  corrected: boolean;
  setBy: { fullName: string };
  setAt: string;
}

export interface WorkerName {
  id: string;
  lastName: string;
  firstName: string;
  patronymic: string | null;
  position: string | null;
}

export interface MonthlyHoursRow {
  assignmentId: string;
  worker: WorkerName;
  siteName: string;
  teamName: string | null;
  from: string;
  until: string | null;
  /** Newest first; the first one counts. */
  history: MonthlyHoursEntry[];
  /** Daily entries exist for the worker this month, so totals can't be added. */
  hasDailyEntries: boolean;
}

export interface MonthlyHoursMonth {
  year: number;
  month: number;
  locked: boolean;
  rows: MonthlyHoursRow[];
}

export type PayrollProblem =
  | { code: 'noSalary' }
  | { code: 'noHours' }
  | { code: 'twoSources' }
  | { code: 'placementWithoutHours'; assignmentId: string; siteName: string; from: string }
  | { code: 'noRules'; siteNames: string[] }
  | { code: 'totalsInvalid'; issues: { siteName: string | null; problem: TotalsProblem }[] }
  | { code: 'invalidHours'; detail: string };

export interface PlaceLabel {
  siteName: string;
  from: string | null;
  until: string | null;
}

export interface PayrollPart {
  /** null: the company default rules */
  ruleSetSiteName: string | null;
  rulesFrom: YearMonth;
  placementIds: string[];
  places: Record<string, PlaceLabel>;
  result: PayResult;
}

export interface PayrollWorker {
  worker: WorkerName;
  salary: { fromYear: number; fromMonth: number; monthlySalary: string } | null;
  source: 'DAILY' | 'TOTALS' | null;
  parts: PayrollPart[];
  total: string | null;
  problems: PayrollProblem[];
}

export interface PayrollMonth {
  year: number;
  month: number;
  locked: boolean;
  total: string;
  workers: PayrollWorker[];
}

export const MONTHLY_HOURS_KEY = ['monthly-hours'] as const;
export const PAYROLL_KEY = ['payroll'] as const;

export function useMonthlyHours({ year, month }: YearMonth) {
  return useQuery({
    queryKey: [...MONTHLY_HOURS_KEY, year, month],
    queryFn: () => api.get<MonthlyHoursMonth>(`/monthly-hours/${year}/${month}`),
  });
}

export function usePayroll({ year, month }: YearMonth) {
  return useQuery({
    queryKey: [...PAYROLL_KEY, year, month],
    queryFn: () => api.get<PayrollMonth>(`/payroll/${year}/${month}`),
  });
}

/** The current month, by the viewer's clock. */
export function currentMonth(): YearMonth {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}
