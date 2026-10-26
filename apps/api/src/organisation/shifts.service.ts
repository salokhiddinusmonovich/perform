import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Shift, UpdateShift, WorkerShift, WorkerShifts } from '@puantaj/schemas';
import { AuditService } from '../audit/audit.service';
import type { CompanyAuthContext } from '../auth/auth.context';
import { conflict, forbidden, notFound } from '../common/api-error';
import { dayToDate, isoDay, monthOfDay, previousDay } from '../common/dates';
import { assertMonthsOpen } from '../pay-rules/months';
import { PrismaService } from '../prisma/prisma.service';
import { assignsShift } from './access';
import { shiftInfo, type ShiftInfo } from './worker-shifts';
import { WorkersService } from './workers.service';

export interface ShiftView extends ShiftInfo {
  isActive: boolean;
  /** A worker has had it, so its normal hours are fixed (shift.inUse) */
  inUse: boolean;
}

/** One row of a worker's shift history. */
export interface WorkerShiftView {
  id: string;
  /** First day on it; it lasts until the next row */
  from: string;
  /** null: no shift from this day (the rule set's normal hours) */
  shift: ShiftInfo | null;
  setBy: { fullName: string };
  setAt: Date;
}

type Tx = Prisma.TransactionClient;

/**
 * Shifts (AGENTS.md: Shifts). Owners and admins define the company's shifts. A worker
 * has a shift from a day until a newer one: owners, admins and accountants give shifts
 * to every worker, timekeepers to workers placed on their sites, many at once. Only
 * owners and admins correct or remove a worker's row. A change may not reach a locked
 * month.
 */
@Injectable()
export class ShiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workers: WorkersService,
    private readonly audit: AuditService,
  ) {}

  async list(auth: CompanyAuthContext): Promise<ShiftView[]> {
    const rows = await this.prisma.shift.findMany({
      where: { companyId: auth.company.id },
      include: { _count: { select: { workers: true } } },
      orderBy: { name: 'asc' },
    });
    return rows.map((s) => ({ ...shiftInfo(s), isActive: s.isActive, inUse: s._count.workers > 0 }));
  }

  async create(auth: CompanyAuthContext, input: Shift): Promise<{ id: string }> {
    const companyId = auth.company.id;
    return this.prisma.$transaction(async (tx) => {
      await this.assertNameFree(tx, companyId, input.name, null);
      const shift = await tx.shift.create({ data: { companyId, ...input } });
      await this.record(tx, auth, 'shift.create', 'Shift', shift.id, { ...input });
      return { id: shift.id };
    });
  }

  async update(auth: CompanyAuthContext, id: string, input: UpdateShift): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.shift.findFirst({ where: { id, companyId } });
      if (!before) throw notFound('shift.notFound');
      if (input.name !== undefined) await this.assertNameFree(tx, companyId, input.name, id);
      const hoursChange =
        input.normalHoursPerDay !== undefined && !before.normalHoursPerDay.equals(input.normalHoursPerDay);
      if (hoursChange && (await tx.workerShift.count({ where: { shiftId: id } })) > 0) throw conflict('shift.inUse');
      await tx.shift.update({ where: { id }, data: input });
      const old = { name: before.name, normalHoursPerDay: before.normalHoursPerDay.toString(), isActive: before.isActive };
      const changes = (Object.keys(input) as (keyof UpdateShift)[]).filter((k) => input[k] !== undefined);
      await this.record(tx, auth, 'shift.update', 'Shift', id, {
        changes: Object.fromEntries(changes.map((k) => [k, { from: old[k], to: input[k] }])),
      });
    });
  }

  /** The worker's shifts, oldest first. Everyone who sees the worker sees them: a shift carries no pay amounts. */
  async forWorker(auth: CompanyAuthContext, workerId: string): Promise<WorkerShiftView[]> {
    await this.workers.find(this.prisma, auth, workerId);
    const rows = await this.prisma.workerShift.findMany({
      where: { companyId: auth.company.id, workerId },
      include: { shift: true, setBy: { select: { fullName: true } } },
      orderBy: { fromDay: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      from: isoDay(r.fromDay),
      shift: r.shift && shiftInfo(r.shift),
      setBy: r.setBy,
      setAt: r.setAt,
    }));
  }

  /**
   * Gives the workers a shift (or none) from a day, all or none of them. Workers already
   * on it that day get no new row and are counted as unchanged.
   */
  async assign(auth: CompanyAuthContext, input: WorkerShifts): Promise<{ added: number; unchanged: number }> {
    const companyId = auth.company.id;
    return this.prisma.$transaction(async (tx) => {
      const shift = await this.offered(tx, companyId, input.shiftId);
      let added = 0;
      for (const workerId of input.workerIds) {
        const worker = await this.workers.find(tx, auth, workerId);
        const placement = worker.assignments.find(
          (p) => isoDay(p.hiredOn) <= input.from && (p.leftOn === null || isoDay(p.leftOn) >= input.from),
        );
        if (!assignsShift(auth, placement ?? null)) throw forbidden();

        const rows = await this.rowsOf(tx, companyId, workerId);
        if (rows.some((r) => isoDay(r.fromDay) === input.from)) throw conflict('workerShift.dayTaken');
        const inForce = rows.filter((r) => isoDay(r.fromDay) < input.from).at(-1) ?? null;
        if ((inForce?.shiftId ?? null) === input.shiftId) continue;
        const next = rows.find((r) => isoDay(r.fromDay) > input.from) ?? null;
        await assertMonthsOpen(tx, companyId, monthOfDay(input.from), next && monthAfterDayBefore(next.fromDay));

        const row = await tx.workerShift.create({
          data: { companyId, workerId, shiftId: input.shiftId, fromDay: dayToDate(input.from), setById: auth.user.id },
        });
        await this.record(tx, auth, 'workerShift.add', 'Worker', workerId, {
          workerShiftId: row.id,
          from: input.from,
          shift: shift && { id: shift.id, name: shift.name, normalHoursPerDay: shift.normalHoursPerDay.toString() },
          before: inForce?.shiftId ?? null,
        });
        added++;
      }
      return { added, unchanged: input.workerIds.length - added };
    });
  }

  /** Corrects a row (owners and admins), audited with old and new values. */
  async correct(auth: CompanyAuthContext, workerId: string, rowId: string, input: WorkerShift): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const row = await this.ownRow(tx, auth, workerId, rowId);
      const shift = await this.offered(tx, companyId, input.shiftId, row.shiftId);
      const before = isoDay(row.fromDay);
      if (before === input.from && row.shiftId === input.shiftId) throw conflict('workerShift.unchanged');
      const rows = await this.rowsOf(tx, companyId, workerId);
      if (rows.some((r) => r.id !== rowId && isoDay(r.fromDay) === input.from)) throw conflict('workerShift.dayTaken');
      await this.assertChangeOpen(tx, companyId, rows, rowId, before < input.from ? before : input.from, before > input.from ? before : input.from);

      await tx.workerShift.update({ where: { id: rowId }, data: { shiftId: input.shiftId, fromDay: dayToDate(input.from) } });
      await this.record(tx, auth, 'workerShift.correct', 'Worker', workerId, {
        workerShiftId: rowId,
        from: { from: before, shiftId: row.shiftId, name: row.shift?.name ?? null },
        to: { from: input.from, shiftId: input.shiftId, name: shift?.name ?? null },
      });
    });
  }

  /** Removes a row entered by mistake (owners and admins): the shift before it lasts on. */
  async remove(auth: CompanyAuthContext, workerId: string, rowId: string): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const row = await this.ownRow(tx, auth, workerId, rowId);
      const day = isoDay(row.fromDay);
      await this.assertChangeOpen(tx, companyId, await this.rowsOf(tx, companyId, workerId), rowId, day, day);
      await tx.workerShift.delete({ where: { id: rowId } });
      await this.record(tx, auth, 'workerShift.remove', 'Worker', workerId, {
        workerShiftId: rowId,
        from: { from: day, shiftId: row.shiftId, name: row.shift?.name ?? null },
      });
    });
  }

  /**
   * A row moved or changed between `earliest` and `latest` changes the days from the
   * earliest until the next other row after the latest.
   */
  private async assertChangeOpen(
    tx: Tx,
    companyId: string,
    rows: readonly { id: string; fromDay: Date }[],
    rowId: string,
    earliest: string,
    latest: string,
  ) {
    const next = rows.find((r) => r.id !== rowId && isoDay(r.fromDay) > latest) ?? null;
    await assertMonthsOpen(tx, companyId, monthOfDay(earliest), next && monthAfterDayBefore(next.fromDay));
  }

  /** A shift that can be given now: this company's and active, unless it is the one already there. */
  private async offered(tx: Tx, companyId: string, shiftId: string | null, current: string | null = null) {
    if (shiftId === null) return null;
    const shift = await tx.shift.findFirst({ where: { id: shiftId, companyId } });
    if (!shift) throw notFound('shift.notFound');
    if (!shift.isActive && shiftId !== current) throw conflict('shift.inactive');
    return shift;
  }

  private async ownRow(tx: Tx, auth: CompanyAuthContext, workerId: string, rowId: string) {
    await this.workers.find(tx, auth, workerId);
    const row = await tx.workerShift.findFirst({
      where: { id: rowId, workerId, companyId: auth.company.id },
      include: { shift: { select: { name: true } } },
    });
    if (!row) throw notFound('workerShift.notFound');
    return row;
  }

  private rowsOf(tx: Tx, companyId: string, workerId: string) {
    return tx.workerShift.findMany({ where: { companyId, workerId }, orderBy: { fromDay: 'asc' } });
  }

  private async assertNameFree(tx: Tx, companyId: string, name: string, exceptId: string | null) {
    const other = await tx.shift.findFirst({
      where: { companyId, name: { equals: name, mode: 'insensitive' }, NOT: exceptId ? { id: exceptId } : undefined },
    });
    if (other) throw conflict('shift.nameTaken');
  }

  private record(
    tx: Tx,
    auth: CompanyAuthContext,
    action: string,
    entityType: string,
    entityId: string,
    data: Prisma.InputJsonObject,
  ) {
    return this.audit.record({ action, companyId: auth.company.id, auth, entityType, entityId, data }, tx);
  }
}

/** The first month a row starting on `day` no longer changes for the rows before it: the month after its day before. */
function monthAfterDayBefore(day: Date) {
  const { year, month } = monthOfDay(previousDay(isoDay(day)));
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}
