import type { Prisma } from '@prisma/client';
import { conflict, notFound } from '../common/api-error';
import { isoDay } from '../common/dates';

/** A position as views name it. */
export interface PositionRef {
  id: string;
  name: string;
}

/** A worker's position rows, newest first, for positionOn() and positionsBetween(). */
export const POSITION_ROWS = {
  orderBy: { fromDay: 'desc' },
  select: { fromDay: true, position: { select: { id: true, name: true } } },
} as const satisfies Prisma.Worker$positionsArgs;

export type PositionRow = { fromDay: Date; position: PositionRef | null };

/** The worker's position on a day (AGENTS.md: Positions): the newest row from that day or earlier; null: not set. */
export function positionOn(rows: readonly PositionRow[], day: string): PositionRef | null {
  return rows.find((r) => isoDay(r.fromDay) <= day)?.position ?? null;
}

/** A position that can be given now: this company's and active, unless it is the one already there. null stays null (none). */
export async function offeredPosition(
  db: Pick<Prisma.TransactionClient, 'position'>,
  companyId: string,
  positionId: string | null,
  current: string | null = null,
) {
  if (positionId === null) return null;
  const position = await db.position.findFirst({ where: { id: positionId, companyId } });
  if (!position) throw notFound('position.notFound');
  if (!position.isActive && positionId !== current) throw conflict('position.inactive');
  return position;
}

/**
 * A worker as month views name them: with the name of their position of the month, the one
 * in force on its last day (AGENTS.md: Positions), in place of their position rows.
 */
export function withPositionName<W extends { positions: readonly PositionRow[] }>(
  worker: W,
  monthLastDay: string,
): Omit<W, 'positions'> & { position: string | null } {
  const { positions, ...rest } = worker;
  return { ...rest, position: positionOn(positions, monthLastDay)?.name ?? null };
}

/** Days of a span on one position, or on none. */
export interface PositionSpan {
  from: string;
  until: string;
  position: PositionRef | null;
}

/**
 * The worker's positions between two days, oldest first: the one in force on the first
 * day, then each one starting later. Rows that change nothing start no new span.
 */
export function positionsBetween(rows: readonly PositionRow[], from: string, until: string): PositionSpan[] {
  const spans: PositionSpan[] = [{ from, until, position: positionOn(rows, from) }];
  for (const r of [...rows].reverse()) {
    const day = isoDay(r.fromDay);
    if (day <= from || day > until) continue;
    const last = spans.at(-1)!;
    if ((last.position?.id ?? null) === (r.position?.id ?? null)) continue;
    last.until = isoDay(new Date(r.fromDay.getTime() - 86_400_000));
    spans.push({ from: day, until, position: r.position });
  }
  return spans;
}
