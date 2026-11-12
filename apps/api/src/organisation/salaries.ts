import type { Prisma } from '@prisma/client';
import type { SalaryFrom } from '@puantaj/payroll';
import { isoDay } from '../common/dates';

/** Newest first: by first day, then the one added last. The first row of a day is the one that counts. */
export const SALARY_ORDER = [{ fromDay: 'desc' }, { seq: 'desc' }] as const satisfies Prisma.SalaryOrderByWithRelationInput[];

/**
 * The salary that counts for a firm among a worker's salaries (newest first, SALARY_ORDER, up
 * to the day in question): the firm's own, else the newest without a firm (AGENTS.md:
 * Firms). A placement without a firm reads only those. While the company doesn't use firms
 * they don't matter, so the newest counts.
 */
export function salaryForFirm<S extends { firmId: string | null }>(
  rows: readonly S[],
  firmId: string | null,
  firmsOn: boolean,
): S | null {
  if (!firmsOn) return rows[0] ?? null;
  return rows.find((r) => r.firmId === firmId) ?? rows.find((r) => r.firmId === null) ?? null;
}

/**
 * A firm's salaries of a worker as the days they start on (AGENTS.md: Salaries), for
 * splitting a month: on every day the one in force is what salaryForFirm() gives for the
 * rows up to that day. Rows are the worker's, newest first (SALARY_ORDER); of two from one
 * day the newer counts. The firm's own salaries, and before its first one those without a
 * firm.
 */
export function salaryChangesFor(
  rows: readonly { firmId: string | null; fromDay: Date; monthlySalary: Prisma.Decimal }[],
  firmId: string | null,
  firmsOn: boolean,
): SalaryFrom[] {
  const own = firmsOn ? rows.filter((r) => r.firmId === firmId) : rows;
  const firstOwn = own.at(-1)?.fromDay ?? null;
  const before = firmsOn && firmId !== null ? rows.filter((r) => r.firmId === null && (!firstOwn || r.fromDay < firstOwn)) : [];
  const out = new Map<string, SalaryFrom>();
  for (const r of [...own, ...before]) {
    const from = isoDay(r.fromDay);
    if (!out.has(from)) out.set(from, { from, monthlySalary: r.monthlySalary.toString() });
  }
  return [...out.values()];
}
