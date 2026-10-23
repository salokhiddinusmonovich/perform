import { Injectable } from '@nestjs/common';
import type { MonthlyHours as MonthlyHoursRow, Prisma } from '@prisma/client';
import { checkTotals, type MonthlyTotals, type TotalsProblem } from '@puantaj/payroll';
import type { MonthlyHours, YearMonth } from '@puantaj/schemas';
import { AuditService } from '../audit/audit.service';
import type { CompanyAuthContext } from '../auth/auth.context';
import { badRequest, conflict, notFound } from '../common/api-error';
import { inMonth, isoDay, monthSpan } from '../common/dates';
import { assertMonthsOpen } from '../pay-rules/months';
import { PayRulesService } from '../pay-rules/pay-rules.service';
import { PrismaService } from '../prisma/prisma.service';

export interface MonthlyHoursEntryView extends MonthlyTotals {
  id: string;
  note: string | null;
  /** A newer entry for the same placement and month corrected this one, so it never counts. */
  corrected: boolean;
  setBy: { fullName: string };
  setAt: Date;
}

/** One placement in the month, with the hours entered for it. */
export interface MonthlyHoursRowView {
  assignmentId: string;
  worker: { id: string; lastName: string; firstName: string; patronymic: string | null; position: string | null };
  siteName: string;
  teamName: string | null;
  /** First and last day of the placement (last null while it continues) */
  from: string;
  until: string | null;
  /** Every entry, newest first; the first one counts. */
  history: MonthlyHoursEntryView[];
  /** The worker has daily timesheet entries this month, so totals can't be added (one source per worker-month). */
  hasDailyEntries: boolean;
}

export interface MonthlyHoursMonthView {
  year: number;
  month: number;
  locked: boolean;
  rows: MonthlyHoursRowView[];
}

type Tx = Prisma.TransactionClient;

const TOTAL_FIELDS = [
  'normalHours',
  'overtimeHours',
  'restDayHours',
  'holidayHours',
  'workdaysWorked',
  'leaveDays',
  'sickDays',
  'travelDays',
] as const satisfies readonly (keyof MonthlyTotals)[];

/** Which form field each totals problem belongs to, with its translation key. */
const PROBLEM_FIELDS: Record<TotalsProblem, { path: keyof MonthlyTotals; message: string }> = {
  NORMAL_ABOVE_DAYS_WORKED: { path: 'normalHours', message: 'validation.normalAboveDaysWorked' },
  WORKDAY_HOURS_ABOVE_DAYS_WORKED: { path: 'overtimeHours', message: 'validation.workdayHoursAboveDaysWorked' },
  DAYS_ABOVE_WORKING_DAYS: { path: 'workdaysWorked', message: 'validation.daysAboveWorkingDays' },
  REST_DAY_HOURS_ABOVE_REST_DAYS: { path: 'restDayHours', message: 'validation.restDayHoursAboveRestDays' },
  HOLIDAY_HOURS_ABOVE_HOLIDAYS: { path: 'holidayHours', message: 'validation.holidayHoursAboveHolidays' },
};

/** A stored row as the engine's totals (decimal strings, whole days). */
export function toTotals(row: MonthlyHoursRow): MonthlyTotals {
  return {
    normalHours: row.normalHours.toString(),
    overtimeHours: row.overtimeHours.toString(),
    restDayHours: row.restDayHours.toString(),
    holidayHours: row.holidayHours.toString(),
    workdaysWorked: row.workdaysWorked,
    leaveDays: row.leaveDays,
    sickDays: row.sickDays,
    travelDays: row.travelDays,
  };
}

/**
 * Hours entered as monthly totals, one set per placement and month, by an owner, admin
 * or accountant (AGENTS.md: Modules, Roles). Entries are only ever added; the newest
 * counts. A worker-month has one source of hours: totals are refused while the worker
 * has daily timesheet entries that month.
 */
@Injectable()
export class MonthlyHoursService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: PayRulesService,
    private readonly audit: AuditService,
  ) {}

  async month(auth: CompanyAuthContext, { year, month }: YearMonth): Promise<MonthlyHoursMonthView> {
    const companyId = auth.company.id;
    const { first, last } = monthSpan(year, month);
    const [placements, locked, daily] = await Promise.all([
      this.prisma.assignment.findMany({
        where: { AND: [{ companyId }, inMonth(year, month)] },
        include: {
          worker: { select: { id: true, lastName: true, firstName: true, patronymic: true, position: true } },
          site: { select: { name: true } },
          team: { select: { name: true } },
          monthlyHours: {
            where: { year, month },
            orderBy: { seq: 'desc' },
            include: { setBy: { select: { fullName: true } } },
          },
        },
      }),
      this.prisma.payrollPeriod.count({ where: { companyId, year, month, status: 'LOCKED' } }),
      this.prisma.timesheetEntry.findMany({
        where: { companyId, date: { gte: first, lte: last } },
        distinct: ['assignmentId'],
        select: { assignment: { select: { workerId: true } } },
      }),
    ]);
    const workersWithDaily = new Set(daily.map((d) => d.assignment.workerId));

    const rows = placements.map((p) => ({
      assignmentId: p.id,
      worker: p.worker,
      siteName: p.site.name,
      teamName: p.team?.name ?? null,
      from: isoDay(p.hiredOn),
      until: p.leftOn ? isoDay(p.leftOn) : null,
      history: p.monthlyHours.map((h, i) => ({
        id: h.id,
        ...toTotals(h),
        note: h.note,
        corrected: i > 0,
        setBy: h.setBy,
        setAt: h.setAt,
      })),
      hasDailyEntries: workersWithDaily.has(p.workerId),
    }));
    const collator = new Intl.Collator('en');
    rows.sort(
      (a, b) =>
        collator.compare(a.worker.lastName, b.worker.lastName) ||
        collator.compare(a.worker.firstName, b.worker.firstName) ||
        a.from.localeCompare(b.from),
    );
    return { year, month, locked: locked > 0, rows };
  }

  async add(auth: CompanyAuthContext, { year, month }: YearMonth, assignmentId: string, input: MonthlyHours) {
    const companyId = auth.company.id;
    return this.prisma.$transaction(async (tx) => {
      await assertMonthsOpen(tx, companyId, { year, month });
      const placement = await tx.assignment.findFirst({ where: { id: assignmentId, companyId } });
      if (!placement) throw notFound('placement.notFound');
      const inThisMonth = await tx.assignment.count({ where: { AND: [{ id: assignmentId }, inMonth(year, month)] } });
      if (inThisMonth === 0) throw conflict('monthlyHours.notInMonth');
      await this.assertNoDailyEntries(tx, companyId, placement.workerId, year, month);

      const totals: MonthlyTotals = Object.fromEntries(TOTAL_FIELDS.map((f) => [f, input[f]])) as unknown as MonthlyTotals;
      await this.assertFitsMonth(tx, companyId, placement.siteId, year, month, totals);

      const previous = await tx.monthlyHours.findFirst({ where: { assignmentId, year, month }, orderBy: { seq: 'desc' } });
      const before = previous && toTotals(previous);
      if (before && TOTAL_FIELDS.every((f) => before[f] === totals[f])) throw conflict('monthlyHours.unchanged');

      const row = await tx.monthlyHours.create({
        data: { companyId, assignmentId, year, month, ...totals, note: input.note, setById: auth.user.id },
      });
      await this.audit.record(
        {
          action: 'monthlyHours.add',
          companyId,
          auth,
          entityType: 'Assignment',
          entityId: assignmentId,
          data: {
            monthlyHoursId: row.id,
            workerId: placement.workerId,
            year,
            month,
            from: before ? { ...before } : null,
            to: { ...totals },
            note: input.note,
          },
        },
        tx,
      );
      return { id: row.id };
    });
  }

  private async assertNoDailyEntries(tx: Tx, companyId: string, workerId: string, year: number, month: number) {
    const { first, last } = monthSpan(year, month);
    const daily = await tx.timesheetEntry.count({
      where: { companyId, assignment: { workerId }, date: { gte: first, lte: last } },
    });
    if (daily > 0) throw conflict('hours.otherSource');
  }

  /** The totals must fit the month under the rules of the placement's site. */
  private async assertFitsMonth(
    tx: Tx,
    companyId: string,
    siteId: string,
    year: number,
    month: number,
    totals: MonthlyTotals,
  ) {
    const set = await this.rules.ruleSetForSite(companyId, siteId, tx);
    const m = set && (await this.rules.month(companyId, set.id, year, month, tx));
    if (!m?.rules || !m.calendar) throw conflict('payRules.notSet');
    const issues = checkTotals([{ place: siteId, totals }], m.calendar, m.rules.settings.normalHoursPerDay);
    if (issues.length > 0) throw badRequest('validation', { issues: issues.map((i) => PROBLEM_FIELDS[i.problem]) });
  }
}
