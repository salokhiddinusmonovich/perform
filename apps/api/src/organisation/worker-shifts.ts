import type { Prisma } from '@prisma/client';
import { buildMonthCalendar, shiftSpans, type ShiftSpan } from '@puantaj/payroll';
import { isoDay, monthSpan } from '../common/dates';

/** A shift as pay and the payslip use it. */
export interface ShiftInfo {
  id: string;
  name: string;
  normalHoursPerDay: string;
}

/** One part of a worker's month: days on one shift, or on none (the rule set's normal hours). */
export interface ShiftPart extends ShiftSpan {
  shiftInfo: ShiftInfo | null;
}

type Db = Pick<Prisma.TransactionClient, 'workerShift'>;

/**
 * Each worker's month split by their shifts (AGENTS.md: Shifts), for payroll and monthly
 * totals. A worker without a shift change in the month has one part, the whole month.
 */
export async function shiftPartsOf(
  db: Db,
  companyId: string,
  workerIds: readonly string[],
  year: number,
  month: number,
): Promise<Map<string, ShiftPart[]>> {
  const rows = await db.workerShift.findMany({
    where: { companyId, workerId: { in: [...workerIds] }, fromDay: { lte: monthSpan(year, month).last } },
    include: { shift: { select: { id: true, name: true, normalHoursPerDay: true } } },
  });
  // Shift kinds of the days don't matter for splitting, only their dates.
  const days = buildMonthCalendar(year, month, { restWeekdays: [], holidays: [] });
  const parts = new Map<string, ShiftPart[]>();
  for (const workerId of workerIds) {
    const own = rows.filter((r) => r.workerId === workerId);
    const info = new Map(own.flatMap((r) => (r.shift ? [[r.shift.id, shiftInfo(r.shift)] as const] : [])));
    const spans = shiftSpans(days, own.map((r) => ({ from: isoDay(r.fromDay), shift: r.shiftId })));
    parts.set(
      workerId,
      spans.map((s) => ({ ...s, shiftInfo: s.shift === null ? null : info.get(s.shift)! })),
    );
  }
  return parts;
}

export function shiftInfo(shift: { id: string; name: string; normalHoursPerDay: Prisma.Decimal }): ShiftInfo {
  return { id: shift.id, name: shift.name, normalHoursPerDay: shift.normalHoursPerDay.toString() };
}

/** The days of a part that a placement covers, or null when it covers none of them. */
export function placementDaysIn(
  part: Pick<ShiftSpan, 'from' | 'until'>,
  placement: { hiredOn: Date; leftOn: Date | null },
): { from: string; until: string } | null {
  const from = isoDay(placement.hiredOn) > part.from ? isoDay(placement.hiredOn) : part.from;
  const until = placement.leftOn && isoDay(placement.leftOn) < part.until ? isoDay(placement.leftOn) : part.until;
  return from <= until ? { from, until } : null;
}
