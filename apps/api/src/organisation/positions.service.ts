import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuditAction, MergePosition, Position, UpdatePosition, WorkerPosition } from '@puantaj/schemas';
import { AuditService } from '../audit/audit.service';
import type { CompanyAuthContext } from '../auth/auth.context';
import { conflict, notFound } from '../common/api-error';
import { dayToDate, isoDay, monthAfterDayBefore, monthOfDay } from '../common/dates';
import { assertMonthsOpen } from '../pay-rules/months';
import { PrismaService } from '../prisma/prisma.service';
import { assertManagesSite } from './access';
import { offeredPosition, type PositionRef } from './worker-positions';
import { WorkersService } from './workers.service';

export interface PositionView extends PositionRef {
  isActive: boolean;
  /** Rows of workers' histories that have it */
  uses: number;
}

/** One row of a worker's position history. */
export interface WorkerPositionView {
  id: string;
  /** First day in it; it lasts until the next row */
  from: string;
  /** null: no position from this day */
  position: PositionRef | null;
  /** null: from before positions were a list */
  setBy: { fullName: string } | null;
  setAt: Date;
}

type Tx = Prisma.TransactionClient;

/**
 * Positions (AGENTS.md: Positions). Owners and admins keep the company's list. A worker
 * has a position from a day until a newer one: whoever may edit the worker adds a row,
 * only owners and admins correct or remove one. Positions never affect pay; a change may
 * still not reach a locked month, which keeps the positions it was locked with.
 */
@Injectable()
export class PositionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workers: WorkersService,
    private readonly audit: AuditService,
  ) {}

  async list(auth: CompanyAuthContext): Promise<PositionView[]> {
    const rows = await this.prisma.position.findMany({
      where: { companyId: auth.company.id },
      include: { _count: { select: { workers: true } } },
      orderBy: { name: 'asc' },
    });
    return rows.map((p) => ({ id: p.id, name: p.name, isActive: p.isActive, uses: p._count.workers }));
  }

  async create(auth: CompanyAuthContext, input: Position): Promise<{ id: string }> {
    return this.prisma.$transaction((tx) => this.createIn(tx, auth, input));
  }

  /** create() inside the caller's transaction (an Excel import adds the positions its user confirmed). */
  async createIn(tx: Tx, auth: CompanyAuthContext, input: Position): Promise<{ id: string }> {
    const companyId = auth.company.id;
    await this.assertNameFree(tx, companyId, input.name, null);
    const position = await tx.position.create({ data: { companyId, ...input } });
    await this.record(tx, auth, 'position.create', 'Position', position.id, { ...input });
    return { id: position.id };
  }

  async update(auth: CompanyAuthContext, id: string, input: UpdatePosition): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.position.findFirst({ where: { id, companyId } });
      if (!before) throw notFound('position.notFound');
      if (input.name !== undefined) await this.assertNameFree(tx, companyId, input.name, id);
      await tx.position.update({ where: { id }, data: input });
      const changes = (Object.keys(input) as (keyof UpdatePosition)[]).filter((k) => input[k] !== undefined);
      await this.record(tx, auth, 'position.update', 'Position', id, {
        changes: Object.fromEntries(changes.map((k) => [k, { from: before[k], to: input[k] }])),
      });
    });
  }

  /**
   * Merges a position into another (near-duplicates such as two spellings): every row of
   * workers' histories with it gets the other, and it is removed. Locked months keep the
   * name they were locked with.
   */
  async merge(auth: CompanyAuthContext, id: string, input: MergePosition): Promise<{ moved: number }> {
    const companyId = auth.company.id;
    return this.prisma.$transaction(async (tx) => {
      if (id === input.intoId) throw conflict('position.mergeIntoItself');
      const [from, into] = await Promise.all([
        tx.position.findFirst({ where: { id, companyId } }),
        tx.position.findFirst({ where: { id: input.intoId, companyId } }),
      ]);
      if (!from || !into) throw notFound('position.notFound');
      const { count } = await tx.workerPosition.updateMany({ where: { companyId, positionId: id }, data: { positionId: into.id } });
      await tx.position.delete({ where: { id } });
      await this.record(tx, auth, 'position.merge', 'Position', into.id, {
        from: { id, name: from.name },
        into: { id: into.id, name: into.name },
        moved: count,
      });
      return { moved: count };
    });
  }

  /** The worker's positions, oldest first. Everyone who sees the worker sees them: a position carries no pay data. */
  async forWorker(auth: CompanyAuthContext, workerId: string): Promise<WorkerPositionView[]> {
    await this.workers.find(this.prisma, auth, workerId);
    const rows = await this.prisma.workerPosition.findMany({
      where: { companyId: auth.company.id, workerId },
      include: { position: { select: { id: true, name: true } }, setBy: { select: { fullName: true } } },
      orderBy: { fromDay: 'asc' },
    });
    return rows.map((r) => ({ id: r.id, from: isoDay(r.fromDay), position: r.position, setBy: r.setBy, setAt: r.setAt }));
  }

  /** Gives the worker a position (or none) from a day, by whoever may edit the worker. */
  async assign(auth: CompanyAuthContext, workerId: string, input: WorkerPosition): Promise<{ id: string }> {
    return this.prisma.$transaction((tx) => this.assignIn(tx, auth, workerId, input));
  }

  /** assign() inside the caller's transaction. */
  async assignIn(tx: Tx, auth: CompanyAuthContext, workerId: string, input: WorkerPosition): Promise<{ id: string }> {
    const companyId = auth.company.id;
    const worker = await this.workers.find(tx, auth, workerId);
    assertManagesSite(auth, worker.assignments[0].siteId);
    const position = await offeredPosition(tx, companyId, input.positionId);

    const rows = await this.rowsOf(tx, companyId, workerId);
    if (rows.some((r) => isoDay(r.fromDay) === input.from)) throw conflict('workerPosition.dayTaken');
    const inForce = rows.filter((r) => isoDay(r.fromDay) < input.from).at(-1) ?? null;
    if ((inForce?.positionId ?? null) === input.positionId) throw conflict('workerPosition.unchanged');
    const next = rows.find((r) => isoDay(r.fromDay) > input.from) ?? null;
    await assertMonthsOpen(tx, companyId, monthOfDay(input.from), next && monthAfterDayBefore(next.fromDay));

    const row = await tx.workerPosition.create({
      data: { companyId, workerId, positionId: input.positionId, fromDay: dayToDate(input.from), setById: auth.user.id },
    });
    await this.record(tx, auth, 'workerPosition.add', 'Worker', workerId, {
      workerPositionId: row.id,
      from: input.from,
      position: position && { id: position.id, name: position.name },
      before: inForce?.positionId ?? null,
    });
    return { id: row.id };
  }

  /** Corrects a row (owners and admins), audited with old and new values. */
  async correct(auth: CompanyAuthContext, workerId: string, rowId: string, input: WorkerPosition): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const row = await this.ownRow(tx, auth, workerId, rowId);
      const position = await offeredPosition(tx, companyId, input.positionId, row.positionId);
      const before = isoDay(row.fromDay);
      if (before === input.from && row.positionId === input.positionId) throw conflict('workerPosition.unchanged');
      const rows = await this.rowsOf(tx, companyId, workerId);
      if (rows.some((r) => r.id !== rowId && isoDay(r.fromDay) === input.from)) throw conflict('workerPosition.dayTaken');
      const [earliest, latest] = before < input.from ? [before, input.from] : [input.from, before];
      await this.assertChangeOpen(tx, companyId, rows, rowId, earliest, latest);

      await tx.workerPosition.update({ where: { id: rowId }, data: { positionId: input.positionId, fromDay: dayToDate(input.from) } });
      await this.record(tx, auth, 'workerPosition.correct', 'Worker', workerId, {
        workerPositionId: rowId,
        from: { from: before, positionId: row.positionId, name: row.position?.name ?? null },
        to: { from: input.from, positionId: input.positionId, name: position?.name ?? null },
      });
    });
  }

  /** Removes a row entered by mistake (owners and admins): the position before it lasts on. */
  async remove(auth: CompanyAuthContext, workerId: string, rowId: string): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const row = await this.ownRow(tx, auth, workerId, rowId);
      const day = isoDay(row.fromDay);
      await this.assertChangeOpen(tx, companyId, await this.rowsOf(tx, companyId, workerId), rowId, day, day);
      await tx.workerPosition.delete({ where: { id: rowId } });
      await this.record(tx, auth, 'workerPosition.remove', 'Worker', workerId, {
        workerPositionId: rowId,
        from: { from: day, positionId: row.positionId, name: row.position?.name ?? null },
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

  private async ownRow(tx: Tx, auth: CompanyAuthContext, workerId: string, rowId: string) {
    await this.workers.find(tx, auth, workerId);
    const row = await tx.workerPosition.findFirst({
      where: { id: rowId, workerId, companyId: auth.company.id },
      include: { position: { select: { name: true } } },
    });
    if (!row) throw notFound('workerPosition.notFound');
    return row;
  }

  private rowsOf(tx: Tx, companyId: string, workerId: string) {
    return tx.workerPosition.findMany({ where: { companyId, workerId }, orderBy: { fromDay: 'asc' } });
  }

  private async assertNameFree(tx: Tx, companyId: string, name: string, exceptId: string | null) {
    const other = await tx.position.findFirst({
      where: { companyId, name: { equals: name, mode: 'insensitive' }, NOT: exceptId ? { id: exceptId } : undefined },
    });
    if (other) throw conflict('position.nameTaken');
  }

  private record(
    tx: Tx,
    auth: CompanyAuthContext,
    action: AuditAction,
    entityType: string,
    entityId: string,
    data: Prisma.InputJsonObject,
  ) {
    return this.audit.record({ action, companyId: auth.company.id, auth, entityType, entityId, data }, tx);
  }
}
