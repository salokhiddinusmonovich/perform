import type { Prisma } from '@prisma/client';
import { buildMonthCalendar, overlapSpans, salarySpans } from '@puantaj/payroll';
import { monthSpan } from '../common/dates';
import { SALARY_ORDER, salaryChangesFor } from './salaries';
import { shiftPartsOf, type ShiftPart } from './worker-shifts';

/**
 * One part of a worker's month with a firm: days on one shift (or none) at one salary
 * (AGENTS.md: Shifts, Salaries). Each part is paid on its own, and monthly totals are
 * entered for each.
 */
export interface MonthPart extends ShiftPart {
  /** The salary the days are paid at, with the day it started; null: none yet on these days */
  salary: { from: string; monthlySalary: string } | null;
}

/** A worker's month split into parts, for the placements of each firm. */
export interface WorkerMonthParts {
  /** The parts of the worker's days with a firm (null: placements without one, or the company doesn't use firms) */
  of(firmId: string | null): MonthPart[];
}

type Db = Pick<Prisma.TransactionClient, 'workerShift' | 'salary'>;

/**
 * Each worker's month split where their shift or their salary changes, for payroll and
 * monthly totals. A worker with neither change in the month has one part, the whole month.
 * Only a change of the salary that counts for a firm splits that firm's days.
 */
export async function monthPartsOf(
  db: Db,
  companyId: string,
  workerIds: readonly string[],
  year: number,
  month: number,
  firmsOn: boolean,
): Promise<Map<string, WorkerMonthParts>> {
  const [shiftParts, salaries] = await Promise.all([
    shiftPartsOf(db, companyId, workerIds, year, month),
    db.salary.findMany({
      where: { companyId, workerId: { in: [...workerIds] }, fromDay: { lte: monthSpan(year, month).last } },
      orderBy: SALARY_ORDER,
    }),
  ]);
  // Only the dates matter for splitting, not the kinds of the days.
  const days = buildMonthCalendar(year, month, { restWeekdays: [], holidays: [] });
  const parts = new Map<string, WorkerMonthParts>();
  for (const workerId of workerIds) {
    const own = salaries.filter((s) => s.workerId === workerId);
    const shifts = shiftParts.get(workerId)!;
    const byFirm = new Map<string | null, MonthPart[]>();
    parts.set(workerId, {
      of(firmId) {
        const key = firmsOn ? firmId : null;
        let found = byFirm.get(key);
        if (!found) {
          found = overlapSpans(shifts, salarySpans(days, salaryChangesFor(own, key, firmsOn))).map(({ from, until, a, b }) => ({
            ...a,
            from,
            until,
            salary: b.monthlySalary === null ? null : { from: b.since!, monthlySalary: b.monthlySalary },
          }));
          byFirm.set(key, found);
        }
        return found;
      },
    });
  }
  return parts;
}
