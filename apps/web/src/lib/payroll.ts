import type { MonthlyTotals, PayOut, PayOutAdjustment, PayResult, TotalsProblem } from '@puantaj/payroll';
import type { AdjustmentType, YearMonth } from '@puantaj/schemas';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { ShiftInfo } from './organisation';

// Monthly hours, adjustments and the payroll run as the API returns them (apps/api/src/payroll).

/** First and last day of a part of the month. */
export interface DaySpan {
  from: string;
  until: string;
}

export interface MonthlyHoursEntry extends MonthlyTotals {
  id: string;
  /** The part of the month it was entered for */
  part: DaySpan;
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
  /** The days of one shift in the month that totals are entered for: the whole month without a shift change */
  part: DaySpan;
  /** The placement's days in the part */
  days: DaySpan;
  /** The part's shift; null: the normal hours of the pay rules */
  shift: ShiftInfo | null;
  /** Newest first; the first one counts. */
  history: MonthlyHoursEntry[];
  /** Entered for days that are no longer a part (the shift changed since): they count for nothing */
  outdated: MonthlyHoursEntry[];
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
  /** until is absent in months locked before shifts */
  | { code: 'placementWithoutHours'; assignmentId: string; siteName: string; from: string; until?: string }
  | { code: 'noRules'; siteNames: string[] }
  | { code: 'noCompanyRules' }
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
  /** The part's shift, or null: the rules' normal hours. Absent in months locked before shifts. */
  shift?: Pick<ShiftInfo, 'name' | 'normalHoursPerDay'> | null;
  /** The part's days. Absent in months locked before shifts. */
  days?: DaySpan;
  rulesFrom: YearMonth;
  placementIds: string[];
  places: Record<string, PlaceLabel>;
  result: PayResult;
}

/** The parts' earned pay, the adjustments (signed, with their notes) and the rounding. */
export interface PayrollPayOut extends Omit<PayOut, 'adjustments'> {
  adjustments: (PayOutAdjustment & { note: string | null })[];
}

export interface PayrollWorker {
  worker: WorkerName;
  /** The worker's department of the month (of their last placement in it); absent in months locked before departments */
  department?: { id: string; name: string } | null;
  salary: { fromYear: number; fromMonth: number; monthlySalary: string } | null;
  source: 'DAILY' | 'IMPORT' | 'TOTALS' | null;
  /** Days of an imported month changed by hand since the import; absent when none */
  editedDays?: number;
  parts: PayrollPart[];
  payOut: PayrollPayOut | null;
  /** The amount to pay out; null while there are problems. Below zero: the worker owes it. */
  total: string | null;
  problems: PayrollProblem[];
}

/** One lock of the month, and the unlock that followed it, if any. */
export interface LockItem {
  lockNumber: number;
  lockedAt: string;
  lockedBy: { fullName: string };
  total: string;
  /** Workers whose pay differs from the lock before; null for the first lock */
  changes: { worker: WorkerName; before: string | null; after: string | null; difference: string | null }[] | null;
  unlocked: { at: string; by: { fullName: string } | null; reason: string } | null;
}

export interface PayrollMonth {
  year: number;
  month: number;
  locked: boolean;
  /** Over in the company's time zone, so it can be locked */
  ended: boolean;
  total: string;
  /** While locked: what the latest lock saved */
  workers: PayrollWorker[];
  /** Totals per department with workers this month, a department's including its sub-departments */
  departments: DepartmentTotal[];
  /** Oldest first */
  locks: LockItem[];
}

/** A department's workers and pay in the month; departmentId null: workers without a department. */
export interface DepartmentTotal {
  departmentId: string | null;
  workers: number;
  /** Not in the total: they can't be paid yet */
  withProblems: number;
  total: string;
}

export interface AdjustmentItem {
  id: string;
  type: AdjustmentType;
  /** Always positive; the type gives the sign */
  amount: string;
  /** Negative for advances and deductions */
  signedAmount: string;
  note: string | null;
  setBy: { fullName: string };
  setAt: string;
  /** Cancelled adjustments stay visible but no longer count. */
  cancelled: { reason: string; by: { fullName: string }; at: string } | null;
}

export interface AdjustmentsRow {
  worker: WorkerName;
  siteNames: string[];
  /** Newest first */
  adjustments: AdjustmentItem[];
  /** Signed sum of the adjustments that count */
  net: string;
}

export interface AdjustmentsMonth {
  year: number;
  month: number;
  locked: boolean;
  rows: AdjustmentsRow[];
}

export const MONTHLY_HOURS_KEY = ['monthly-hours'] as const;
export const ADJUSTMENTS_KEY = ['adjustments'] as const;
export const PAYROLL_KEY = ['payroll'] as const;

export function useMonthlyHours({ year, month }: YearMonth) {
  return useQuery({
    queryKey: [...MONTHLY_HOURS_KEY, year, month],
    queryFn: () => api.get<MonthlyHoursMonth>(`/monthly-hours/${year}/${month}`),
  });
}

export function useAdjustments({ year, month }: YearMonth) {
  return useQuery({
    queryKey: [...ADJUSTMENTS_KEY, year, month],
    queryFn: () => api.get<AdjustmentsMonth>(`/adjustments/${year}/${month}`),
  });
}

/** Whether a signed amount from the API (a decimal string) is below zero. */
export const isNegative = (amount: string) => amount.startsWith('-');

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
