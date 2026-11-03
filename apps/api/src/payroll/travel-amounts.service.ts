import { Injectable } from '@nestjs/common';
import type { TravelPayMode } from '@prisma/client';
import type { TravelAmount, YearMonth } from '@puantaj/schemas';
import { AuditService } from '../audit/audit.service';
import type { CompanyAuthContext } from '../auth/auth.context';
import { conflict, notFound } from '../common/api-error';
import { inMonth, isoDay } from '../common/dates';
import { categoriesInMonth } from '../organisation/worker-categories.service';
import { assertMonthsOpen } from '../pay-rules/months';
import { PayRulesService } from '../pay-rules/pay-rules.service';
import { PrismaService } from '../prisma/prisma.service';

export interface TravelAmountEntryView {
  id: string;
  amount: string;
  note: string | null;
  /** A newer amount for the same placement and month corrected this one, so it never counts. */
  corrected: boolean;
  setBy: { fullName: string };
  setAt: Date;
}

/** One placement in the month, with the travel amounts entered for it. */
export interface TravelAmountRowView {
  assignmentId: string;
  worker: { id: string; employeeNumber: string | null; lastName: string; firstName: string; patronymic: string | null; position: string | null };
  siteName: string;
  teamId: string | null;
  teamName: string | null;
  departmentId: string | null;
  /** First and last day of the placement (last null while it continues) */
  from: string;
  until: string | null;
  /**
   * How the rules that pay the placement this month pay travel: only MONTHLY_AMOUNT pays the
   * amount. null: no rules can pay the placement yet (the payroll page says why).
   */
  travelPayMode: TravelPayMode | null;
  /** Every amount for the month, newest first; the first one counts. */
  history: TravelAmountEntryView[];
}

export interface TravelAmountsMonthView {
  year: number;
  month: number;
  locked: boolean;
  rows: TravelAmountRowView[];
}

/**
 * Monthly travel amounts (AGENTS.md: Travel pay): one per placement and month, added by an
 * owner, admin or accountant while the month is open. Amounts are only ever added; the
 * newest counts, and 0 pays none. Payroll pays it when the placement's rules pay travel as a
 * monthly amount, once per placement however the month is split.
 */
@Injectable()
export class TravelAmountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: PayRulesService,
    private readonly audit: AuditService,
  ) {}

  async month(auth: CompanyAuthContext, { year, month }: YearMonth): Promise<TravelAmountsMonthView> {
    const companyId = auth.company.id;
    const [placements, locked] = await Promise.all([
      this.prisma.assignment.findMany({
        where: { AND: [{ companyId }, inMonth(year, month)] },
        include: {
          worker: { select: { id: true, employeeNumber: true, lastName: true, firstName: true, patronymic: true, position: true } },
          site: { select: { name: true } },
          team: { select: { name: true } },
          travelAmounts: {
            where: { year, month },
            orderBy: { seq: 'desc' },
            include: { setBy: { select: { fullName: true } } },
          },
        },
      }),
      this.prisma.payrollPeriod.count({ where: { companyId, year, month, status: 'LOCKED' } }),
    ]);
    const options = await categoriesInMonth(this.prisma, companyId, [...new Set(placements.map((p) => p.workerId))], year, month);
    const modes = new Map<string, Promise<TravelPayMode | null>>();
    /** The travel pay mode of the rules that pay a placement, looked up once per site, firm and options. */
    const modeOf = (p: (typeof placements)[number]) => {
      const firmId = auth.company.firms ? p.firmId : null;
      const workerOptions = options.get(p.workerId)!;
      const key = `${p.siteId}/${firmId}/${JSON.stringify(Object.entries(workerOptions).sort())}`;
      let found = modes.get(key);
      if (!found) {
        found = this.rules
          .rulesForWorker(companyId, { siteId: p.siteId, firmId }, workerOptions, year, month)
          .then((r) => (r.problem ? null : (r.month?.rules?.settings.travelPayMode ?? null)));
        modes.set(key, found);
      }
      return found;
    };

    const rows: TravelAmountRowView[] = [];
    for (const p of placements) {
      rows.push({
        assignmentId: p.id,
        worker: p.worker,
        siteName: p.site.name,
        teamId: p.teamId,
        teamName: p.team?.name ?? null,
        departmentId: p.departmentId,
        from: isoDay(p.hiredOn),
        until: p.leftOn ? isoDay(p.leftOn) : null,
        travelPayMode: await modeOf(p),
        history: p.travelAmounts.map((a, i) => ({
          id: a.id,
          amount: a.amount.toString(),
          note: a.note,
          corrected: i > 0,
          setBy: a.setBy,
          setAt: a.setAt,
        })),
      });
    }
    const collator = new Intl.Collator('en');
    rows.sort(
      (a, b) =>
        collator.compare(a.worker.lastName, b.worker.lastName) ||
        collator.compare(a.worker.firstName, b.worker.firstName) ||
        a.from.localeCompare(b.from),
    );
    return { year, month, locked: locked > 0, rows };
  }

  async add(auth: CompanyAuthContext, { year, month }: YearMonth, assignmentId: string, input: TravelAmount) {
    const companyId = auth.company.id;
    return this.prisma.$transaction(async (tx) => {
      await assertMonthsOpen(tx, companyId, { year, month });
      const placement = await tx.assignment.findFirst({ where: { id: assignmentId, companyId } });
      if (!placement) throw notFound('placement.notFound');
      const inThisMonth = await tx.assignment.count({ where: { AND: [{ id: assignmentId }, inMonth(year, month)] } });
      if (inThisMonth === 0) throw conflict('travelAmount.notInMonth');

      const previous = await tx.travelAmount.findFirst({ where: { assignmentId, year, month }, orderBy: { seq: 'desc' } });
      if (previous?.amount.equals(input.amount)) throw conflict('travelAmount.unchanged');
      const row = await tx.travelAmount.create({
        data: { companyId, assignmentId, year, month, amount: input.amount, note: input.note, setById: auth.user.id },
      });
      await this.audit.record(
        {
          action: 'travelAmount.add',
          companyId,
          auth,
          entityType: 'Assignment',
          entityId: assignmentId,
          data: {
            travelAmountId: row.id,
            workerId: placement.workerId,
            year,
            month,
            from: previous ? previous.amount.toString() : null,
            to: input.amount,
            note: input.note,
          },
        },
        tx,
      );
      return { id: row.id };
    });
  }
}
