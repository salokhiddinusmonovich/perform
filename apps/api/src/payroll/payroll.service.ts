import { Injectable } from '@nestjs/common';
import { Prisma, type FirmType, type MonthlyHours as MonthlyHoursRow } from '@prisma/client';
import {
  calculatePay,
  checkTotals,
  payOut,
  spanCalendar,
  type DayEntry,
  type PayOut,
  type PayOutAdjustment,
  type PayResult,
  type PaySettings,
  type TotalsProblem,
  type TravelInput,
} from '@puantaj/payroll';
import type { YearMonth } from '@puantaj/schemas';
import { AuditService } from '../audit/audit.service';
import type { CompanyAuthContext } from '../auth/auth.context';
import { conflict } from '../common/api-error';
import { inMonth, isoDay, monthSpan, todayIn } from '../common/dates';
import { seesPlacement } from '../organisation/access';
import { subtreeIds } from '../organisation/departments.service';
import { placementDaysIn, shiftPartsOf, type ShiftPart } from '../organisation/worker-shifts';
import { SALARY_ORDER, salaryForFirm } from '../organisation/workers.service';
import { lockCompanyMonths } from '../pay-rules/months';
import { PayRulesService, type MonthRules, type StoredPayRules } from '../pay-rules/pay-rules.service';
import { PrismaService } from '../prisma/prisma.service';
import { COUNTING_ADJUSTMENTS } from './adjustments.service';
import { toTotals } from './monthly-hours.service';

/** Why a worker's month can't be paid yet. Missing or contradictory data is never guessed. */
export type PayrollProblem =
  /** firmName: the firm without a salary, while the company uses firms */
  | { code: 'noSalary'; firmName?: string }
  /** An adjustment names no firm, or one without a payslip this month, so it fits no payslip (AGENTS.md: Firms) */
  | { code: 'adjustmentWithoutFirm' }
  | { code: 'noHours' }
  /** Hours come from more than one of daily entries, an Excel import and monthly totals: one source per worker-month */
  | { code: 'twoSources' }
  /**
   * Hours come from totals, but these days of a placement have none: the placement in the
   * month, or its part of a shift change (totals entered before the change count for nothing).
   * until is absent in months locked before shifts.
   */
  | { code: 'placementWithoutHours'; assignmentId: string; siteName: string; from: string; until?: string }
  /** No pay rules for the month at these sites */
  | { code: 'noRules'; siteNames: string[] }
  /** The company default rules, which hold the rounding step, are not set for the month */
  | { code: 'noCompanyRules' }
  /** siteName null: the placements' totals together don't fit */
  | { code: 'totalsInvalid'; issues: { siteName: string | null; problem: TotalsProblem }[] }
  /** Daily entries that contradict each other (the engine says how) */
  | { code: 'invalidHours'; detail: string };

/**
 * What a pay line's place key stands for: a site and team the hours were entered at
 * (daily entries, placeKey) or a placement (totals).
 */
export interface PlaceLabel {
  siteName: string;
  /** The team of a place with one; absent in months locked before teams were told apart */
  teamName?: string | null;
  /** A placement's first and last day; null for a site */
  from: string | null;
  until: string | null;
}

/**
 * Key of the place daily hours were entered at. A worker's day may be split between
 * teams of one site too, so the team is part of it.
 */
const placeKey = (siteId: string, teamId: string | null) => (teamId ? `${siteId}/${teamId}` : siteId);

/**
 * The days of the worker's placements under one rule set and on one shift, paid under the
 * rule set's rules with the shift's normal hours.
 */
export interface PayrollPartView {
  /** Site whose own rules apply, or null: the company default or a firm's */
  ruleSetSiteName: string | null;
  /** Firm whose own rules apply; absent otherwise */
  ruleSetFirmName?: string;
  /** The firm whose payslip the part is on; absent while the company doesn't use firms */
  firm?: FirmRef | null;
  /** The part's shift, or null: the rule set's normal hours. Absent in months locked before shifts. */
  shift?: { name: string; normalHoursPerDay: string } | null;
  /** First and last day of the part. Absent in months locked before shifts. */
  days?: { from: string; until: string };
  /** Month the rule version in force starts from */
  rulesFrom: { year: number; month: number };
  placementIds: string[];
  /** Labels of the places the pay lines are charged to */
  places: Record<string, PlaceLabel>;
  result: PayResult;
}

/** The pay-out with each adjustment's note, so the payslip can explain it. */
export interface PayOutView extends Omit<PayOut, 'adjustments'> {
  adjustments: (PayOutAdjustment & { note: string | null })[];
}

/** A firm as a pay result names it. */
export interface FirmRef {
  id: string;
  name: string;
  type: FirmType;
}

/**
 * What one firm pays the worker for the month (AGENTS.md: Firms), rounded on its own. Its
 * parts are the worker's parts with this firm. Without firms, the worker's one payslip.
 */
export interface PayslipView {
  firm: FirmRef | null;
  salary: { fromYear: number; fromMonth: number; monthlySalary: string };
  payOut: PayOutView;
  total: string;
}

export interface PayrollWorkerView {
  worker: { id: string; employeeNumber: string | null; lastName: string; firstName: string; patronymic: string | null; position: string | null };
  /**
   * The worker's department for the month (AGENTS.md: Departments): the one of their last
   * placement in it, so each worker counts in one department's totals. null: none set;
   * absent in months locked before departments.
   */
  department?: { id: string; name: string } | null;
  /** Sites of the worker's placements in the month, in placement order; absent in months locked before this was saved */
  siteNames?: string[];
  /** Firms of the worker's placements in the month; absent while the company doesn't use firms and in months locked before them */
  firms?: FirmRef[];
  /** The salary of the firm of the last placement in the month */
  salary: { fromYear: number; fromMonth: number; monthlySalary: string } | null;
  /** Where the hours came from (IMPORT: an Excel import, AGENTS.md: Excel import), or null when there are none */
  source: 'DAILY' | 'IMPORT' | 'TOTALS' | null;
  /** Days of an imported month changed by hand since the import; absent when none */
  editedDays?: number;
  /** Empty while there are problems */
  parts: PayrollPartView[];
  /** Earned pay of the parts, adjustments and rounding; null while there are problems, and with more than one payslip */
  payOut: PayOutView | null;
  /** One per firm paying the worker this month; empty while there are problems, absent in months locked before firms */
  payslips?: PayslipView[];
  /** The amount to pay out (the payslips' totals together); null while there are problems. Below zero: the worker owes it. */
  total: string | null;
  problems: PayrollProblem[];
}

/** A worker whose pay differs between one lock of a month and the one before. */
export interface LockChangeView {
  worker: PayrollWorkerView['worker'];
  /** null: not in the earlier lock */
  before: string | null;
  /** null: not in this lock */
  after: string | null;
  /** after − before, when the worker is in both */
  difference: string | null;
}

/** One lock of the month, and the unlock that followed it, if any. */
export interface LockView {
  lockNumber: number;
  lockedAt: Date;
  lockedBy: { fullName: string };
  total: string;
  /** Differences from the lock before; null for the first lock */
  changes: LockChangeView[] | null;
  unlocked: { at: Date; by: { fullName: string } | null; reason: string } | null;
}

/**
 * A department's workers and pay in the month (AGENTS.md: Departments), including its
 * sub-departments. Each worker counts in their department of the month (PayrollWorkerView).
 */
export interface DepartmentTotalView {
  /** null: workers without a department */
  departmentId: string | null;
  workers: number;
  /** Workers that can't be paid yet, so not in the total */
  withProblems: number;
  /** Sum of the workers that could be paid */
  total: string;
}

/**
 * A firm's workers and pay in the month (AGENTS.md: Firms). A worker who moved between firms
 * counts in both, each with what that firm pays them.
 */
export interface FirmTotalView {
  /** null: workers with a placement without a firm */
  firm: FirmRef | null;
  workers: number;
  /** Workers that can't be paid yet, so not in the total */
  withProblems: number;
  /** Sum of the payslips of this firm */
  total: string;
}

export interface PayrollMonthView {
  year: number;
  month: number;
  locked: boolean;
  /** The month is over in the company's time zone, so it can be locked */
  ended: boolean;
  /** Sum of the workers that could be paid */
  total: string;
  /** While locked: what the latest lock saved. Otherwise worked out now. */
  workers: PayrollWorkerView[];
  /** Totals per department with workers this month, a department's including its sub-departments */
  departments: DepartmentTotalView[];
  /** Totals per firm with workers this month */
  firms: FirmTotalView[];
  /** Every lock of the month, oldest first */
  locks: LockView[];
}

type Db = Prisma.TransactionClient | PrismaService;
type Sees = (placement: { siteId: string; teamId: string | null }) => boolean;

const PLACEMENT_INCLUDE = {
  worker: { select: { id: true, employeeNumber: true, lastName: true, firstName: true, patronymic: true, position: true } },
  site: { select: { name: true } },
  department: { select: { id: true, name: true } },
  firm: { select: { id: true, name: true, type: true } },
  travelRoute: { select: { name: true, amountPerDay: true } },
} as const satisfies Prisma.AssignmentInclude;

type Placement = Prisma.AssignmentGetPayload<{ include: typeof PLACEMENT_INCLUDE }> & {
  /** The month's totals, newest first; the newest for a part's days counts */
  monthlyHours: MonthlyHoursRow[];
};

type PartEntry = Prisma.TimesheetEntryGetPayload<{
  include: { site: { select: { name: true } }; team: { select: { name: true } } };
}>;

/**
 * Works out every worker's pay for a month with @puantaj/payroll, from salaries, hours
 * (daily entries or monthly totals), pay rules and travel pay. Split by placement
 * (AGENTS.md: Pay model): the worker's placements are grouped by their firm and rule set
 * (AGENTS.md: Firms), and each group is paid under its own rules at its firm's salary. Split by shift (AGENTS.md: Shifts):
 * each group is split again where the worker's shift changes, each part with its shift's
 * normal hours. Per firm, the parts and the adjustments make the amount that firm pays out,
 * rounded once with the company's step.
 */
@Injectable()
export class PayrollService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: PayRulesService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The month's pay. Project managers see the workers with a placement on their sites
   * this month; everyone else sees all.
   */
  async month(auth: CompanyAuthContext, ym: YearMonth): Promise<PayrollMonthView> {
    const companyId = auth.company.id;
    const sees: Sees = (p) => seesPlacement(auth, p.siteId, p.teamId);
    const period = await this.prisma.payrollPeriod.findUnique({
      where: { companyId_year_month: { companyId, year: ym.year, month: ym.month } },
    });
    const snapshots = period
      ? await this.prisma.payrollSnapshot.findMany({
          where: { companyId, periodId: period.id },
          orderBy: { lockNumber: 'asc' },
          include: { lockedBy: { select: { fullName: true } }, workers: true },
        })
      : [];
    const unlocks = period
      ? await this.prisma.auditLog.findMany({
          where: { companyId, action: 'period.unlock', entityType: 'PayrollPeriod', entityId: period.id },
          include: { actor: { select: { fullName: true } } },
        })
      : [];

    const locked = period?.status === 'LOCKED';
    const visible = await this.visibleWorkers(companyId, ym, sees);
    // A locked month shows what was locked; only who may see whom is worked out now.
    const workers = locked
      ? snapshots.at(-1)!.workers.filter((w) => visible.has(w.workerId)).map((w) => detailOf(w.detail))
      : await this.calculate(this.prisma, companyId, ym, sees, auth.company.firms);

    return {
      year: ym.year,
      month: ym.month,
      locked,
      ended: monthEnded(auth.company.timezone, ym),
      total: sumTotals(workers),
      workers,
      departments: await this.departmentTotals(companyId, workers),
      firms: firmTotals(workers),
      locks: snapshots.map((snap, i) => {
        const unlock = unlocks.find((u) => (u.data as { lockNumber?: number }).lockNumber === snap.lockNumber);
        return {
          lockNumber: snap.lockNumber,
          lockedAt: snap.lockedAt,
          lockedBy: snap.lockedBy,
          total: snap.workers
            .filter((w) => visible.has(w.workerId))
            .reduce((sum, w) => sum.plus(w.total), new Prisma.Decimal(0))
            .toFixed(2),
          changes: i === 0 ? null : changesBetween(snapshots[i - 1].workers, snap.workers, visible),
          unlocked: unlock
            ? { at: unlock.createdAt, by: unlock.actor, reason: String((unlock.data as { reason?: string }).reason ?? '') }
            : null,
        };
      }),
    };
  }

  /**
   * Locks a month that has ended and whose every worker can be paid, saving what it pays
   * as the next snapshot (AGENTS.md: Data integrity). Owners, admins and accountants.
   */
  async lock(auth: CompanyAuthContext, ym: YearMonth): Promise<{ lockNumber: number }> {
    const companyId = auth.company.id;
    if (!monthEnded(auth.company.timezone, ym)) throw conflict('period.notEnded');
    return this.prisma.$transaction(
      async (tx) => {
        // No change to the company's months runs while the month is worked out and locked.
        await lockCompanyMonths(tx, companyId);
        const key = { companyId_year_month: { companyId, year: ym.year, month: ym.month } };
        const before = await tx.payrollPeriod.findUnique({ where: key });
        if (before?.status === 'LOCKED') throw conflict('period.alreadyLocked');

        const workers = await this.calculate(tx, companyId, ym, () => true, auth.company.firms);
        const unpaid = workers.filter((w) => w.problems.length > 0).length;
        if (unpaid > 0) throw conflict('period.hasProblems', { workers: unpaid });

        const lockedAt = new Date();
        const lockFields = { status: 'LOCKED' as const, lockedAt, lockedById: auth.user.id };
        const period = await tx.payrollPeriod.upsert({
          where: key,
          create: { companyId, year: ym.year, month: ym.month, ...lockFields },
          update: lockFields,
        });
        const lockNumber = (await tx.payrollSnapshot.count({ where: { periodId: period.id } })) + 1;
        const total = sumTotals(workers);
        const snapshot = await tx.payrollSnapshot.create({
          data: { companyId, periodId: period.id, lockNumber, total, lockedById: auth.user.id, lockedAt },
        });
        await tx.payrollSnapshotWorker.createMany({
          data: workers.map((w) => ({
            companyId,
            snapshotId: snapshot.id,
            workerId: w.worker.id,
            total: w.total!,
            detail: JSON.parse(JSON.stringify(w)) as Prisma.InputJsonObject,
          })),
        });
        await this.audit.record(
          {
            action: 'period.lock',
            companyId,
            auth,
            entityType: 'PayrollPeriod',
            entityId: period.id,
            data: { year: ym.year, month: ym.month, lockNumber, snapshotId: snapshot.id, total, workers: workers.length },
          },
          tx,
        );
        return { lockNumber };
      },
      // Working out a large month takes longer than Prisma's default 5 seconds.
      { timeout: 60_000 },
    );
  }

  /** Reopens a locked month (owners only), with the reason in the audit log. Snapshots stay. */
  async unlock(auth: CompanyAuthContext, ym: YearMonth, reason: string): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      await lockCompanyMonths(tx, companyId);
      const period = await tx.payrollPeriod.findUnique({
        where: { companyId_year_month: { companyId, year: ym.year, month: ym.month } },
      });
      if (period?.status !== 'LOCKED') throw conflict('period.notLocked');
      const lockNumber = await tx.payrollSnapshot.count({ where: { periodId: period.id } });
      await tx.payrollPeriod.update({
        where: { id: period.id },
        data: { status: 'OPEN', lockedAt: null, lockedById: null },
      });
      await this.audit.record(
        {
          action: 'period.unlock',
          companyId,
          auth,
          entityType: 'PayrollPeriod',
          entityId: period.id,
          data: { year: ym.year, month: ym.month, lockNumber, reason },
        },
        tx,
      );
    });
  }

  /** Totals per department, each including the departments under it; workers without one last. */
  private async departmentTotals(companyId: string, workers: readonly PayrollWorkerView[]): Promise<DepartmentTotalView[]> {
    const all = await this.prisma.department.findMany({
      where: { companyId },
      select: { id: true, parentId: true },
      orderBy: { name: 'asc' },
    });
    const totals = (rows: readonly PayrollWorkerView[]) => ({
      workers: rows.length,
      withProblems: rows.filter((w) => w.total === null).length,
      total: sumTotals(rows),
    });
    const out: DepartmentTotalView[] = all.flatMap((d) => {
      const ids = subtreeIds(all, d.id);
      const rows = workers.filter((w) => w.department && ids.has(w.department.id));
      return rows.length > 0 ? [{ departmentId: d.id, ...totals(rows) }] : [];
    });
    const without = workers.filter((w) => !w.department);
    if (without.length > 0) out.push({ departmentId: null, ...totals(without) });
    return out;
  }

  /** Workers with a placement in the month that the caller sees. */
  private async visibleWorkers(companyId: string, { year, month }: YearMonth, sees: Sees): Promise<Set<string>> {
    const rows = await this.prisma.assignment.findMany({
      where: { AND: [{ companyId }, inMonth(year, month)] },
      select: { workerId: true, siteId: true, teamId: true },
    });
    return new Set(rows.filter(sees).map((r) => r.workerId));
  }

  /** Every visible worker's pay for the month, worked out now. */
  private async calculate(
    db: Db,
    companyId: string,
    { year, month }: YearMonth,
    sees: Sees,
    firmsOn: boolean,
  ): Promise<PayrollWorkerView[]> {
    const { first, last } = monthSpan(year, month);
    const rows = await db.assignment.findMany({
      where: { AND: [{ companyId }, inMonth(year, month)] },
      include: {
        ...PLACEMENT_INCLUDE,
        monthlyHours: { where: { year, month }, orderBy: { seq: 'desc' } },
      },
      orderBy: { hiredOn: 'asc' },
    });

    const visible = new Set(rows.filter(sees).map((p) => p.workerId));
    const placements: Placement[] = rows.filter((p) => visible.has(p.workerId));
    const assignmentIds = placements.map((p) => p.id);
    const workerIds = [...visible];

    const [salaries, entries, editedDays, travelAmounts, adjustments, companyRules, shiftParts] = await Promise.all([
      db.salary.findMany({
        where: {
          companyId,
          workerId: { in: workerIds },
          OR: [{ fromYear: { lt: year } }, { fromYear: year, fromMonth: { lte: month } }],
        },
        orderBy: SALARY_ORDER,
      }),
      db.timesheetEntry.findMany({
        where: { companyId, assignmentId: { in: assignmentIds }, date: { gte: first, lte: last } },
        include: { site: { select: { name: true } }, team: { select: { name: true } } },
      }),
      db.importedDayEdit.findMany({
        where: { companyId, workerId: { in: workerIds }, date: { gte: first, lte: last } },
        select: { workerId: true },
      }),
      // The newest amount of each placement counts.
      db.travelAmount.findMany({
        where: { companyId, year, month, assignmentId: { in: assignmentIds } },
        orderBy: { seq: 'desc' },
        distinct: ['assignmentId'],
      }),
      db.adjustment.findMany({
        where: { companyId, year, month, workerId: { in: workerIds }, ...COUNTING_ADJUSTMENTS },
        orderBy: { seq: 'asc' },
      }),
      this.rules
        .defaultRuleSet(companyId, db)
        .then((set) => (set ? this.rules.month(companyId, set.id, year, month, db) : null)),
      shiftPartsOf(db, companyId, workerIds, year, month),
    ]);
    const roundingStep = companyRules?.rules?.settings.payRoundingStep ?? null;

    /** While the company doesn't use firms, placements count as having none. */
    const firmOf = (p: Placement): FirmRef | null => (firmsOn ? p.firm : null);
    const monthRules = new Map<
      string,
      Promise<{ ruleSetId: string | null; siteId: string | null; firmId: string | null; month: MonthRules | null }>
    >();
    const rulesOf = (p: Placement) => {
      const firmId = firmOf(p)?.id ?? null;
      const key = `${p.siteId}/${firmId}`;
      let found = monthRules.get(key);
      if (!found) {
        found = this.rules.ruleSetForPlacement(companyId, { siteId: p.siteId, firmId }, year, month, db).then(async (set) => ({
          ruleSetId: set?.id ?? null,
          siteId: set?.siteId ?? null,
          firmId: set?.firmId ?? null,
          month: set ? await this.rules.month(companyId, set.id, year, month, db) : null,
        }));
        monthRules.set(key, found);
      }
      return found;
    };

    const workers: PayrollWorkerView[] = [];
    for (const workerId of workerIds) {
      const own = placements.filter((p) => p.workerId === workerId);
      const ownSalaries = salaries.filter((s) => s.workerId === workerId);
      const salaryOf = (firm: FirmRef | null) => salaryForFirm(ownSalaries, firm?.id ?? null, firmsOn);
      const ownFirms = [...new Map(own.map((p) => [firmOf(p)?.id ?? null, firmOf(p)])).values()];
      const salary = salaryOf(firmOf(own.at(-1)!));
      const ownEntries = entries.filter((e) => own.some((p) => p.id === e.assignmentId));
      const view: PayrollWorkerView = {
        worker: own[0].worker,
        // Placements are in the order of their first day.
        department: own.at(-1)!.department,
        siteNames: [...new Set(own.map((p) => p.site.name))],
        ...(firmsOn ? { firms: ownFirms.filter((f) => f !== null) } : {}),
        salary: salary && {
          fromYear: salary.fromYear,
          fromMonth: salary.fromMonth,
          monthlySalary: salary.monthlySalary.toString(),
        },
        source: null,
        parts: [],
        payOut: null,
        total: null,
        problems: [],
      };
      workers.push(view);

      const parts = shiftParts.get(workerId)!;
      const sources = [
        own.some((p) => p.monthlyHours.length > 0) && ('TOTALS' as const),
        ownEntries.some((e) => e.importId === null) && ('DAILY' as const),
        ownEntries.some((e) => e.importId !== null) && ('IMPORT' as const),
      ].filter((s) => s !== false);
      if (sources.length > 1) view.problems.push({ code: 'twoSources' });
      else if (sources.length === 1) view.source = sources[0];
      else view.problems.push({ code: 'noHours' });
      const edited = editedDays.filter((d) => d.workerId === workerId).length;
      if (edited > 0) view.editedDays = edited;
      for (const firm of ownFirms) {
        if (!salaryOf(firm)) view.problems.push(firm ? { code: 'noSalary', firmName: firm.name } : { code: 'noSalary' });
      }
      if (view.source === 'TOTALS') {
        for (const p of own) {
          for (const part of parts) {
            const days = placementDaysIn(part, p);
            if (days && !totalsFor(p, part)) {
              view.problems.push({ code: 'placementWithoutHours', assignmentId: p.id, siteName: p.site.name, ...days });
            }
          }
        }
      }

      // Group the placements by their firm and rule set.
      const groups = new Map<string, { firm: FirmRef | null; rules: Awaited<ReturnType<typeof rulesOf>>; placements: Placement[] }>();
      const withoutRules: string[] = [];
      for (const p of own) {
        const r = await rulesOf(p);
        if (!r.ruleSetId || !r.month?.rules) {
          withoutRules.push(p.site.name);
          continue;
        }
        const firm = firmOf(p);
        const key = `${firm?.id ?? ''}/${r.ruleSetId}`;
        const group = groups.get(key);
        if (group) group.placements.push(p);
        else groups.set(key, { firm, rules: r, placements: [p] });
      }
      if (withoutRules.length > 0) view.problems.push({ code: 'noRules', siteNames: [...new Set(withoutRules)] });
      else if (roundingStep === null) view.problems.push({ code: 'noCompanyRules' });
      if (view.problems.length > 0) continue;

      for (const { firm, rules, placements: inGroup } of groups.values()) {
        for (const shiftPart of parts) {
          const inPart = inGroup.filter((p) => placementDaysIn(shiftPart, p));
          if (inPart.length === 0) continue;
          const part = payPart(view, salaryOf(firm)!, rules, firm, firmsOn, rules.month!, shiftPart, inPart, ownEntries, travelAmounts);
          if (part) view.parts.push(part);
        }
      }
      // Each adjustment goes to the payslip of its firm; with one payslip, one naming no firm goes there too.
      const ownAdjustments = adjustments.filter((a) => a.workerId === workerId);
      const adjustmentsOf = (firm: FirmRef | null) =>
        firmsOn
          ? ownAdjustments.filter((a) => a.firmId === (firm?.id ?? null) || (a.firmId === null && ownFirms.length === 1))
          : ownAdjustments;
      if (ownFirms.reduce((n, firm) => n + adjustmentsOf(firm).length, 0) !== ownAdjustments.length) {
        view.problems.push({ code: 'adjustmentWithoutFirm' });
      }
      if (view.problems.length > 0) view.parts = [];
      else {
        // Parts in the order of their days, payslips in the order of their first part.
        view.parts.sort((a, b) => a.days!.from.localeCompare(b.days!.from));
        const firstDay = (firm: FirmRef | null) => view.parts.find((p) => (p.firm?.id ?? null) === (firm?.id ?? null))!.days!.from;
        view.payslips = [...ownFirms]
          .sort((a, b) => firstDay(a).localeCompare(firstDay(b)))
          .map((firm) => {
            const ofFirm = adjustmentsOf(firm);
            const out = payOut(
              view.parts.filter((p) => (p.firm?.id ?? null) === (firm?.id ?? null)).map((p) => p.result),
              ofFirm.map((a) => ({ id: a.id, type: a.type, amount: a.amount.toString() })),
              roundingStep!,
            );
            const paid = salaryOf(firm)!;
            return {
              firm,
              salary: { fromYear: paid.fromYear, fromMonth: paid.fromMonth, monthlySalary: paid.monthlySalary.toString() },
              payOut: {
                ...out,
                adjustments: out.adjustments.map((a) => ({ ...a, note: ofFirm.find((o) => o.id === a.id)!.note })),
              },
              total: out.total,
            };
          });
        view.payOut = view.payslips.length === 1 ? view.payslips[0].payOut : null;
        view.total = view.payslips.reduce((sum, p) => sum.plus(p.total), new Prisma.Decimal(0)).toFixed(2);
      }
    }

    const collator = new Intl.Collator('en');
    workers.sort(
      (a, b) =>
        collator.compare(a.worker.lastName, b.worker.lastName) || collator.compare(a.worker.firstName, b.worker.firstName),
    );
    return workers;
  }

}

/**
 * One part of a worker's month: the placements of one rule set on the days of one shift,
 * paid with the shift's normal hours (the rule set's without a shift) on the part's own
 * calendar. Working days stay the rule set's for the month. Returns null after adding a
 * problem when the hours can't be paid.
 */
function payPart(
  view: PayrollWorkerView,
  salary: { monthlySalary: Prisma.Decimal },
  ruleSet: { siteId: string | null; firmId: string | null },
  firm: FirmRef | null,
  firmsOn: boolean,
  m: MonthRules,
  shiftPart: ShiftPart,
  inPart: readonly Placement[],
  ownEntries: readonly PartEntry[],
  travelAmounts: readonly { assignmentId: string; amount: Prisma.Decimal }[],
): PayrollPartView | null {
  const settings = m.rules!.settings;
  const normalHoursPerDay = shiftPart.shiftInfo?.normalHoursPerDay ?? settings.normalHoursPerDay;
  const calendar = spanCalendar(m.calendar!, shiftPart);
  const ids = new Set(inPart.map((p) => p.id));
  const covered = inPart.map((p) => placementDaysIn(shiftPart, p)!);
  const days = { from: covered.map((d) => d.from).sort()[0], until: covered.map((d) => d.until).sort().at(-1)! };
  const places: Record<string, PlaceLabel> = {};
  const base = {
    monthlySalary: salary.monthlySalary.toString(),
    workingDays: m.workingDays!,
    calendar,
    settings: { ...paySettings(settings), normalHoursPerDay },
  };
  let result: PayResult;
  try {
    if (view.source === 'TOTALS') {
      const totals = inPart.map((p) => ({ place: p.id, totals: toTotals(totalsFor(p, shiftPart)!) }));
      const issues = checkTotals(totals, calendar, normalHoursPerDay);
      if (issues.length > 0) {
        const siteName = (place: string | null) => inPart.find((p) => p.id === place)?.site.name ?? null;
        view.problems.push({
          code: 'totalsInvalid',
          issues: issues.map((i) => ({ siteName: siteName(i.place), problem: i.problem })),
        });
        return null;
      }
      for (const p of inPart) {
        places[p.id] = { siteName: p.site.name, from: isoDay(p.hiredOn), until: p.leftOn ? isoDay(p.leftOn) : null };
      }
      const routes = Object.fromEntries(inPart.map((p) => [p.id, route(p)]));
      result = calculatePay({ ...base, totals, travel: travel(settings, routes, inPart, travelAmounts) });
    } else {
      const inThisPart = ownEntries.filter(
        (e) => ids.has(e.assignmentId) && isoDay(e.date) >= shiftPart.from && isoDay(e.date) <= shiftPart.until,
      );
      const partEntries: DayEntry[] = inThisPart.map((e) => ({
        date: isoDay(e.date),
        place: placeKey(e.siteId, e.teamId),
        seq: Number(e.seq),
        status: e.status,
        hours: e.hours.toString(),
      }));
      // A place's route is the worker's route on their placement at its site; elsewhere none.
      const routes: Record<string, ReturnType<typeof route>> = {};
      for (const e of inThisPart) {
        const key = placeKey(e.siteId, e.teamId);
        places[key] = { siteName: e.site.name, teamName: e.team?.name ?? null, from: null, until: null };
        const p = inPart.find((x) => x.siteId === e.siteId);
        routes[key] = p ? route(p) : null;
      }
      result = calculatePay({ ...base, entries: partEntries, travel: travel(settings, routes, inPart, travelAmounts) });
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    view.problems.push({ code: 'invalidHours', detail: error.message });
    return null;
  }
  return {
    ruleSetSiteName: ruleSet.siteId ? inPart.find((p) => p.siteId === ruleSet.siteId)?.site.name ?? null : null,
    ...(ruleSet.firmId && firm ? { ruleSetFirmName: firm.name } : {}),
    ...(firmsOn ? { firm } : {}),
    shift: shiftPart.shiftInfo && { name: shiftPart.shiftInfo.name, normalHoursPerDay: shiftPart.shiftInfo.normalHoursPerDay },
    days,
    rulesFrom: { year: m.rules!.fromYear, month: m.rules!.fromMonth },
    placementIds: inPart.map((p) => p.id),
    places,
    result,
  };
}

/** A placement's newest totals for a part's days, if any. */
function totalsFor(p: Placement, part: Pick<ShiftPart, 'from' | 'until'>): MonthlyHoursRow | undefined {
  return p.monthlyHours.find((h) => isoDay(h.fromDay) === part.from && isoDay(h.untilDay) === part.until);
}

/** Pay rules (Settings) as the engine takes them. Normal hours are always paid at × 1. */
function paySettings(rules: StoredPayRules): PaySettings {
  return {
    normalHoursPerDay: rules.normalHoursPerDay,
    multipliers: {
      NORMAL: '1',
      OVERTIME: rules.overtimeMultiplier,
      REST_DAY: rules.restDayMultiplier,
      HOLIDAY: rules.holidayMultiplier,
    },
    absence: rules.absence,
  };
}

function route(p: Placement) {
  return p.travelRoute ? { route: p.travelRoute.name, amountPerDay: p.travelRoute.amountPerDay.toString() } : null;
}

/**
 * Travel pay of a part under its rules: per day worked at each place's route, or the
 * monthly amounts the accountant entered for these placements (none entered: none paid).
 */
function travel(
  rules: StoredPayRules,
  routes: Record<string, ReturnType<typeof route>>,
  inPart: readonly Placement[],
  amounts: readonly { assignmentId: string; amount: Prisma.Decimal }[],
): TravelInput | null {
  if (rules.travelPayMode === 'PER_DAY_WORKED') return { kind: 'PER_DAY_WORKED', routes };
  if (rules.travelPayMode === 'MONTHLY_AMOUNT') {
    const own = amounts.filter((a) => inPart.some((p) => p.id === a.assignmentId));
    if (own.length === 0) return null;
    const sum = own.reduce((acc, a) => acc.plus(a.amount), new Prisma.Decimal(0));
    return { kind: 'MONTHLY_AMOUNT', amount: sum.toFixed(2) };
  }
  return null;
}

/** Totals per firm, from what each worker's payslips say; workers without a firm last. */
function firmTotals(workers: readonly PayrollWorkerView[]): FirmTotalView[] {
  const totals = new Map<string, FirmTotalView>();
  const add = (firm: FirmRef | null, withProblems: boolean, amount: string) => {
    const key = firm?.id ?? '';
    const row = totals.get(key) ?? { firm, workers: 0, withProblems: 0, total: '0.00' };
    row.workers++;
    if (withProblems) row.withProblems++;
    row.total = new Prisma.Decimal(row.total).plus(amount).toFixed(2);
    totals.set(key, row);
  };
  for (const w of workers) {
    if (!w.firms) continue;
    if (w.payslips) for (const slip of w.payslips) add(slip.firm, false, slip.total);
    else if (w.firms.length > 0) for (const firm of w.firms) add(firm, true, '0');
    else add(null, true, '0');
  }
  const collator = new Intl.Collator('en');
  return [...totals.values()].sort((a, b) => {
    if (!a.firm || !b.firm) return a.firm ? -1 : 1;
    return collator.compare(a.firm.name, b.firm.name);
  });
}

/** Sum of the totals of the workers that can be paid. */
function sumTotals(workers: readonly PayrollWorkerView[]): string {
  return workers
    .reduce((sum, w) => (w.total === null ? sum : sum.plus(w.total)), new Prisma.Decimal(0))
    .toFixed(2);
}

/** A snapshot's stored worker result (written by lock() from PayrollWorkerView). */
function detailOf(detail: Prisma.JsonValue): PayrollWorkerView {
  return detail as unknown as PayrollWorkerView;
}

/** The month's last day is before today in the company's time zone. */
function monthEnded(timeZone: string, { year, month }: YearMonth): boolean {
  return isoDay(monthSpan(year, month).last) < todayIn(timeZone);
}

/** Workers whose pay differs between two locks, among those the caller sees. */
function changesBetween(
  before: readonly { workerId: string; total: Prisma.Decimal; detail: Prisma.JsonValue }[],
  after: readonly { workerId: string; total: Prisma.Decimal; detail: Prisma.JsonValue }[],
  visible: ReadonlySet<string>,
): LockChangeView[] {
  const ids = [...new Set([...before, ...after].map((w) => w.workerId))].filter((id) => visible.has(id));
  return ids.flatMap((id) => {
    const b = before.find((w) => w.workerId === id);
    const a = after.find((w) => w.workerId === id);
    if (a && b && a.total.equals(b.total)) return [];
    return [
      {
        worker: detailOf((a ?? b)!.detail).worker,
        before: b ? b.total.toFixed(2) : null,
        after: a ? a.total.toFixed(2) : null,
        difference: a && b ? a.total.minus(b.total).toFixed(2) : null,
      },
    ];
  });
}

