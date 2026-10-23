import type { Prisma } from '@prisma/client';
import { conflict } from '../common/api-error';

/** A month as a number that orders correctly: year × 12 + (month − 1). */
export const monthIndex = (year: number, month: number) => year * 12 + month - 1;

type Db = Pick<Prisma.TransactionClient, 'payrollPeriod' | '$executeRaw'>;

/**
 * Serializes changes to a company's months with locking them: every change takes this
 * lock shared (assertMonthsOpen), locking and unlocking take it exclusive
 * (lockCompanyMonths). A lock therefore waits for changes already under way, and changes
 * that come after it see the month locked. Held until the transaction ends.
 */
async function monthsLock(db: Db, companyId: string, exclusive: boolean) {
  const key = `months:${companyId}`;
  if (exclusive) await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  else await db.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${key}))`;
}

/** For locking and unlocking a month: no change to any of the company's months runs meanwhile. */
export const lockCompanyMonths = (db: Db, companyId: string) => monthsLock(db, companyId, true);

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
  await monthsLock(db, companyId, false);
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
