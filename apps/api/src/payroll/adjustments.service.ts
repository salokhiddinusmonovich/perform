import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ADJUSTMENT_SIGN } from '@puantaj/payroll';
import type { Adjustment, AdjustmentType, YearMonth } from '@puantaj/schemas';
import { AuditService } from '../audit/audit.service';
import type { CompanyAuthContext } from '../auth/auth.context';
import { conflict, notFound } from '../common/api-error';
import { inMonth } from '../common/dates';
import { seesPlacement } from '../organisation/access';
import { assertMonthsOpen } from '../pay-rules/months';
import { PrismaService } from '../prisma/prisma.service';

export interface AdjustmentView {
  id: string;
  type: AdjustmentType;
  /** Always positive; the type gives the sign */
  amount: string;
  /** The amount with its sign: negative for advances and deductions */
  signedAmount: string;
  note: string | null;
  setBy: { fullName: string };
  setAt: Date;
  /** Cancelled adjustments stay visible but no longer count. */
  cancelled: { reason: string; by: { fullName: string }; at: Date } | null;
}

/** A worker with a placement in the month, and their adjustments. */
export interface AdjustmentRowView {
  worker: { id: string; employeeNumber: string | null; lastName: string; firstName: string; patronymic: string | null; position: string | null };
  /** Sites of the worker's placements in the month, in placement order */
  siteNames: string[];
  /** The department of the worker's last placement in the month, as in the payroll run; null: none */
  departmentId: string | null;
  /** Newest first */
  adjustments: AdjustmentView[];
  /** Signed sum of the adjustments that count */
  net: string;
}

export interface AdjustmentsMonthView {
  year: number;
  month: number;
  locked: boolean;
  rows: AdjustmentRowView[];
}

/** The adjustments that count in a worker-month (not cancelled). Payroll reads only these. */
export const COUNTING_ADJUSTMENTS = { cancel: { is: null } } as const satisfies Prisma.AdjustmentWhereInput;

/**
 * Bonuses, advances and deductions per worker and month (AGENTS.md: Adjustments).
 * Owners, admins and accountants add and cancel them; project managers see those of the
 * workers on their sites. Only ever added: a mistake is cancelled, never edited.
 */
@Injectable()
export class AdjustmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async month(auth: CompanyAuthContext, { year, month }: YearMonth): Promise<AdjustmentsMonthView> {
    const companyId = auth.company.id;
    const [placements, locked] = await Promise.all([
      this.prisma.assignment.findMany({
        where: { AND: [{ companyId }, inMonth(year, month)] },
        select: {
          workerId: true,
          siteId: true,
          teamId: true,
          departmentId: true,
          site: { select: { name: true } },
          worker: { select: { id: true, employeeNumber: true, lastName: true, firstName: true, patronymic: true, position: true } },
        },
        orderBy: { hiredOn: 'asc' },
      }),
      this.prisma.payrollPeriod.count({ where: { companyId, year, month, status: 'LOCKED' } }),
    ]);
    const visible = new Set(placements.filter((p) => seesPlacement(auth, p.siteId, p.teamId)).map((p) => p.workerId));
    const adjustments = await this.prisma.adjustment.findMany({
      where: { companyId, year, month, workerId: { in: [...visible] } },
      include: {
        setBy: { select: { fullName: true } },
        cancel: { include: { cancelledBy: { select: { fullName: true } } } },
      },
      orderBy: { seq: 'desc' },
    });

    const rows: AdjustmentRowView[] = [...visible].map((workerId) => {
      const own = placements.filter((p) => p.workerId === workerId);
      const list = adjustments
        .filter((a) => a.workerId === workerId)
        .map((a) => ({ ...a, signed: ADJUSTMENT_SIGN[a.type] < 0n ? a.amount.neg() : a.amount }));
      return {
        worker: own[0].worker,
        siteNames: [...new Set(own.map((p) => p.site.name))],
        departmentId: own.at(-1)!.departmentId,
        adjustments: list.map((a) => ({
          id: a.id,
          type: a.type,
          amount: a.amount.toString(),
          signedAmount: a.signed.toFixed(2),
          note: a.note,
          setBy: a.setBy,
          setAt: a.setAt,
          cancelled: a.cancel && { reason: a.cancel.reason, by: a.cancel.cancelledBy, at: a.cancel.cancelledAt },
        })),
        net: list
          .filter((a) => !a.cancel)
          .reduce((sum, a) => sum.plus(a.signed), new Prisma.Decimal(0))
          .toFixed(2),
      };
    });
    const collator = new Intl.Collator('en');
    rows.sort(
      (a, b) =>
        collator.compare(a.worker.lastName, b.worker.lastName) || collator.compare(a.worker.firstName, b.worker.firstName),
    );
    return { year, month, locked: locked > 0, rows };
  }

  /** Adds an adjustment to a worker-month that is open and in which the worker has a placement. */
  async add(auth: CompanyAuthContext, { year, month }: YearMonth, workerId: string, input: Adjustment): Promise<{ id: string }> {
    const companyId = auth.company.id;
    return this.prisma.$transaction(async (tx) => {
      await assertMonthsOpen(tx, companyId, { year, month });
      const worker = await tx.worker.findFirst({ where: { id: workerId, companyId }, select: { id: true } });
      if (!worker) throw notFound('worker.notFound');
      const placed = await tx.assignment.count({ where: { AND: [{ companyId, workerId }, inMonth(year, month)] } });
      if (placed === 0) throw conflict('adjustment.notInMonth');

      const row = await tx.adjustment.create({
        data: { companyId, workerId, year, month, type: input.type, amount: input.amount, note: input.note, setById: auth.user.id },
      });
      await this.audit.record(
        {
          action: 'adjustment.add',
          companyId,
          auth,
          entityType: 'Worker',
          entityId: workerId,
          data: { adjustmentId: row.id, year, month, type: input.type, amount: input.amount, note: input.note },
        },
        tx,
      );
      return { id: row.id };
    });
  }

  /** Cancels an adjustment of an open month, with a reason. It stays visible and no longer counts. */
  async cancel(auth: CompanyAuthContext, id: string, reason: string): Promise<void> {
    const companyId = auth.company.id;
    try {
      await this.prisma.$transaction(async (tx) => {
        const adjustment = await tx.adjustment.findFirst({ where: { id, companyId }, include: { cancel: true } });
        if (!adjustment) throw notFound('adjustment.notFound');
        await assertMonthsOpen(tx, companyId, { year: adjustment.year, month: adjustment.month });
        if (adjustment.cancel) throw conflict('adjustment.alreadyCancelled');

        const cancel = await tx.adjustmentCancel.create({
          data: { companyId, adjustmentId: id, reason, cancelledById: auth.user.id },
        });
        await this.audit.record(
          {
            action: 'adjustment.cancel',
            companyId,
            auth,
            entityType: 'Worker',
            entityId: adjustment.workerId,
            data: {
              adjustmentId: id,
              cancelId: cancel.id,
              year: adjustment.year,
              month: adjustment.month,
              type: adjustment.type,
              amount: adjustment.amount.toString(),
              reason,
            },
          },
          tx,
        );
      });
    } catch (error) {
      // Two cancels at once: the unique key lets only one through.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw conflict('adjustment.alreadyCancelled');
      }
      throw error;
    }
  }
}
