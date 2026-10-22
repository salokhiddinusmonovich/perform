import type { Prisma } from '@prisma/client';
import { conflict } from '../common/api-error';

/** A month as a number that orders correctly: year × 12 + (month − 1). */
export const monthIndex = (year: number, month: number) => year * 12 + month - 1;

type Db = Pick<Prisma.TransactionClient, 'payrollPeriod'>;

/**
 * Refuses a change that would alter a locked month (AGENTS.md: locked months are
 * final). `from` is the first month affected; `until` the first month no longer
 * affected, or null when the change reaches every later month.
 */
export async function assertMonthsOpen(
  db: Db,
  companyId: string,
  from: { year: number; month: number },
  until: { year: number; month: number } | null = { year: from.year, month: from.month + 1 },
): Promise<void> {
  const start = monthIndex(from.year, from.month);
  const end = until ? monthIndex(until.year, until.month) : Infinity;
  const locked = await db.payrollPeriod.findMany({
    where: { companyId, status: 'LOCKED', year: { gte: from.year } },
    select: { year: true, month: true },
  });
  if (locked.some((p) => monthIndex(p.year, p.month) >= start && monthIndex(p.year, p.month) < end)) {
    throw conflict('period.locked');
  }
}
