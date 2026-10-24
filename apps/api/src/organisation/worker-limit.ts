import type { Prisma } from '@prisma/client';
import { conflict } from '../common/api-error';
import { inMonth, monthOfDay, todayIn } from '../common/dates';
import { planHistory, planOfMonth } from '../platform/company-plan';

type Db = Pick<Prisma.TransactionClient, 'assignment'>;

/** Active workers in a month: workers with a placement overlapping it (AGENTS.md: Plans). */
export async function countActiveWorkers(db: Db, companyId: string, year: number, month: number): Promise<number> {
  const rows = await db.assignment.findMany({
    where: { companyId, ...inMonth(year, month) },
    distinct: ['workerId'],
    select: { workerId: true },
  });
  return rows.length;
}

/**
 * Runs a change that places a worker from `fromDay`, and refuses it with
 * `plan.workerLimitReached` when it adds an active worker beyond the plan's limit. It is
 * checked against the plan of the month the placement starts, or of the current month
 * if it started earlier. A worker who was already active that month (e.g. moving to
 * another site) never counts as added, so existing workers are never blocked, even over
 * the limit.
 */
export async function withinWorkerLimit<T>(
  tx: Prisma.TransactionClient,
  companyId: string,
  workerId: string | null,
  fromDay: string,
  change: () => Promise<T>,
): Promise<T> {
  const company = await tx.company.findUniqueOrThrow({ where: { id: companyId } });
  const today = todayIn(company.timezone);
  const { year, month } = monthOfDay(fromDay > today ? fromDay : today);
  const plan = planOfMonth(await planHistory(tx, companyId), { year, month });
  if (!plan) return change();

  const wasActive =
    workerId !== null && (await tx.assignment.count({ where: { companyId, workerId, ...inMonth(year, month) } })) > 0;
  const result = await change();
  if (!wasActive) {
    const limit = plan.maxActiveWorkers;
    if ((await countActiveWorkers(tx, companyId, year, month)) > limit) {
      throw conflict('plan.workerLimitReached', { limit, year, month });
    }
  }
  return result;
}
