import type { Plan, Prisma } from '@prisma/client';
import { isoDay, monthOfDay } from '../common/dates';

// A company's plan per month (AGENTS.md: Plans). Each month has exactly one plan, so price,
// worker limit and modules never change partway through a month: a change always starts
// on the 1st of the next month.

/** A company's CompanyPlan rows with their plans, oldest first (`include` for a company query). */
export const PLAN_HISTORY = { orderBy: { fromMonth: 'asc' }, include: { plan: true } } as const;

export type PlanHistory = { fromMonth: Date; plan: Plan }[];

type YearMonth = { year: number; month: number };

/** "YYYY-MM-01" of a month. */
export const firstOfMonth = ({ year, month }: YearMonth) => `${year}-${String(month).padStart(2, '0')}-01`;

/** The month after the one `day` ("YYYY-MM-DD") falls in. */
export function nextMonth(day: string): YearMonth {
  const { year, month } = monthOfDay(day);
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

/** The plan of a month: the latest row starting on or before it. null before any (a company from before plans). */
export function planOfMonth(history: PlanHistory, month: YearMonth): Plan | null {
  const first = firstOfMonth(month);
  let plan: Plan | null = null;
  for (const row of history) if (isoDay(row.fromMonth) <= first) plan = row.plan;
  return plan;
}

/** A change that hasn't started yet (it starts after `today`), or null. */
export function pendingPlan(history: PlanHistory, today: string): { fromMonth: string; plan: Plan } | null {
  const row = history.find((r) => isoDay(r.fromMonth) > today);
  return row ? { fromMonth: isoDay(row.fromMonth), plan: row.plan } : null;
}

export async function planHistory(db: Pick<Prisma.TransactionClient, 'companyPlan'>, companyId: string): Promise<PlanHistory> {
  return db.companyPlan.findMany({ where: { companyId }, ...PLAN_HISTORY });
}

/**
 * Whether the Timesheet module is open to the company now: its plan has it this month, or
 * an earlier month that had it isn't locked yet, so that month's hours can still be
 * finished after the module was turned off (AGENTS.md: Modules). Hours of each month are
 * still entered only if that month's plan has the module.
 */
export async function timesheetOpen(
  db: Pick<Prisma.TransactionClient, 'payrollPeriod'>,
  companyId: string,
  history: PlanHistory,
  today: string,
): Promise<boolean> {
  const current = monthOfDay(today);
  if (planOfMonth(history, current)?.timesheetModule) return true;
  const earlier = timesheetMonthsBefore(history, current);
  if (earlier.length === 0) return false;
  const locked = await db.payrollPeriod.count({ where: { companyId, status: 'LOCKED', OR: earlier } });
  return locked < earlier.length;
}

/** Every month before `until` whose plan has the Timesheet module. */
function timesheetMonthsBefore(history: PlanHistory, until: YearMonth): YearMonth[] {
  const months: YearMonth[] = [];
  const end = until.year * 12 + until.month - 1;
  history.forEach((row, i) => {
    if (!row.plan.timesheetModule) return;
    const from = monthOfDay(isoDay(row.fromMonth));
    const next = history[i + 1];
    const to = next ? monthOfDay(isoDay(next.fromMonth)) : until;
    for (let m = from.year * 12 + from.month - 1; m < Math.min(to.year * 12 + to.month - 1, end); m++) {
      months.push({ year: Math.floor(m / 12), month: (m % 12) + 1 });
    }
  });
  return months;
}

/** Whether the plan of this month has the Timesheet module (its daily hours can be entered). */
export async function timesheetIn(
  db: Pick<Prisma.TransactionClient, 'companyPlan'>,
  companyId: string,
  month: YearMonth,
): Promise<boolean> {
  return planOfMonth(await planHistory(db, companyId), month)?.timesheetModule ?? false;
}
