import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  calculatePay,
  checkTotals,
  payOut,
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
import { SALARY_ORDER } from '../organisation/workers.service';
import { lockCompanyMonths } from '../pay-rules/months';
import { PayRulesService, type MonthRules, type StoredPayRules } from '../pay-rules/pay-rules.service';
import { PrismaService } from '../prisma/prisma.service';
import { COUNTING_ADJUSTMENTS } from './adjustments.service';
import { toTotals } from './monthly-hours.service';

/** Why a worker's month can't be paid yet. Missing or contradictory data is never guessed. */
export type PayrollProblem =
  | { code: 'noSalary' }
  | { code: 'noHours' }
  /** Daily entries and monthly totals both exist: one source per worker-month */
  | { code: 'twoSources' }
  /** Hours come from totals, but this placement in the month has none */
  | { code: 'placementWithoutHours'; assignmentId: string; siteName: string; from: string }
  /** No pay rules for the month at these sites */
  | { code: 'noRules'; siteNames: string[] }
  /** The company default rules, which hold the rounding step, are not set for the month */
  | { code: 'noCompanyRules' }
  /** siteName null: the placements' totals together don't fit */
  | { code: 'totalsInvalid'; issues: { siteName: string | null; problem: TotalsProblem }[] }
  /** Daily entries that contradict each other (the engine says how) */
  | { code: 'invalidHours'; detail: string };

/** What a pay line's place key stands for: a site (daily entries) or a placement (totals). */
export interface PlaceLabel {
  siteName: string;
  /** A placement's first and last day; null for a site */
  from: string | null;
  until: string | null;
}

/** The days of the worker's placements under one rule set, paid under its rules. */
export interface PayrollPartView {
  /** Site whose own rules apply, or null: the company default */
  ruleSetSiteName: string | null;
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

export interface PayrollWorkerView {
  worker: { id: string; lastName: string; firstName: string; patronymic: string | null; position: string | null };
  salary: { fromYear: number; fromMonth: number; monthlySalary: string } | null;
  /** Where the hours came from, or null when there are none */
  source: 'DAILY' | 'TOTALS' | null;
  /** Empty while there are problems */
  parts: PayrollPartView[];
  /** Earned pay of the parts, adjustments and rounding; null while there are problems */
  payOut: PayOutView | null;
  /** The amount to pay out (payOut.total); null while there are problems. Below zero: the worker owes it. */
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
  /** Every lock of the month, oldest first */
  locks: LockView[];
}

type Db = Prisma.TransactionClient | PrismaService;
type Sees = (placement: { siteId: string; teamId: string | null }) => boolean;

const PLACEMENT_INCLUDE = {
  worker: { select: { id: true, lastName: true, firstName: true, patronymic: true, position: true } },
  site: { select: { name: true } },
  travelRoute: { select: { name: true, amountPerDay: true } },
} as const satisfies Prisma.AssignmentInclude;

type Placement = Prisma.AssignmentGetPayload<{ include: typeof PLACEMENT_INCLUDE }> & {
  totals: ReturnType<typeof toTotals> | null;
};

/**
 * Works out every worker's pay for a month with @puantaj/payroll, from salaries, hours
 * (daily entries or monthly totals), pay rules and travel pay. Split by placement
 * (AGENTS.md: Pay model): the worker's placements are grouped by the rule set of their
 * site, and each group is a part paid under its own rules. The parts and the worker's
 * adjustments make the amount to pay out, rounded once with the company's step.
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
      : await this.calculate(this.prisma, companyId, ym, sees);

    return {
      year: ym.year,
      month: ym.month,
      locked,
      ended: monthEnded(auth.company.timezone, ym),
      total: sumTotals(workers),
      workers,
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

        const workers = await this.calculate(tx, companyId, ym, () => true);
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

  /** Workers with a placement in the month that the caller sees. */
  private async visibleWorkers(companyId: string, { year, month }: YearMonth, sees: Sees): Promise<Set<string>> {
    const rows = await this.prisma.assignment.findMany({
      where: { AND: [{ companyId }, inMonth(year, month)] },
      select: { workerId: true, siteId: true, teamId: true },
    });
    return new Set(rows.filter(sees).map((r) => r.workerId));
  }

  /** Every visible worker's pay for the month, worked out now. */
  private async calculate(db: Db, companyId: string, { year, month }: YearMonth, sees: Sees): Promise<PayrollWorkerView[]> {
    const { first, last } = monthSpan(year, month);
    const rows = await db.assignment.findMany({
      where: { AND: [{ companyId }, inMonth(year, month)] },
      include: {
        ...PLACEMENT_INCLUDE,
        monthlyHours: { where: { year, month }, orderBy: { seq: 'desc' }, take: 1 },
      },
      orderBy: { hiredOn: 'asc' },
    });

    const visible = new Set(rows.filter(sees).map((p) => p.workerId));
    const placements: Placement[] = rows
      .filter((p) => visible.has(p.workerId))
      .map(({ monthlyHours, ...p }) => ({ ...p, totals: monthlyHours[0] ? toTotals(monthlyHours[0]) : null }));
    const assignmentIds = placements.map((p) => p.id);
    const workerIds = [...visible];

    const [salaries, entries, travelAmounts, adjustments, companyRules] = await Promise.all([
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
    ]);
    const roundingStep = companyRules?.rules?.settings.payRoundingStep ?? null;

    const monthRules = new Map<string, Promise<{ ruleSetId: string | null; siteId: string | null; month: MonthRules | null }>>();
    const rulesAt = (siteId: string) => {
      let found = monthRules.get(siteId);
      if (!found) {
        found = this.rules.ruleSetForSite(companyId, siteId, db).then(async (set) => ({
          ruleSetId: set?.id ?? null,
          siteId: set?.siteId ?? null,
          month: set ? await this.rules.month(companyId, set.id, year, month, db) : null,
        }));
        monthRules.set(siteId, found);
      }
      return found;
    };

    const workers: PayrollWorkerView[] = [];
    for (const workerId of workerIds) {
      const own = placements.filter((p) => p.workerId === workerId);
      const salary = salaries.find((s) => s.workerId === workerId) ?? null;
      const ownEntries = entries.filter((e) => own.some((p) => p.id === e.assignmentId));
      const view: PayrollWorkerView = {
        worker: own[0].worker,
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

      const hasTotals = own.some((p) => p.totals);
      if (hasTotals && ownEntries.length > 0) view.problems.push({ code: 'twoSources' });
      else if (hasTotals) view.source = 'TOTALS';
      else if (ownEntries.length > 0) view.source = 'DAILY';
      else view.problems.push({ code: 'noHours' });
      if (!salary) view.problems.push({ code: 'noSalary' });
      if (view.source === 'TOTALS') {
        for (const p of own) {
          if (!p.totals) {
            view.problems.push({ code: 'placementWithoutHours', assignmentId: p.id, siteName: p.site.name, from: isoDay(p.hiredOn) });
          }
        }
      }

      // Group the placements by the rule set of their site.
      const groups = new Map<string, { rules: Awaited<ReturnType<typeof rulesAt>>; placements: Placement[] }>();
      const withoutRules: string[] = [];
      for (const p of own) {
        const r = await rulesAt(p.siteId);
        if (!r.ruleSetId || !r.month?.rules) {
          withoutRules.push(p.site.name);
          continue;
        }
        const group = groups.get(r.ruleSetId);
        if (group) group.placements.push(p);
        else groups.set(r.ruleSetId, { rules: r, placements: [p] });
      }
      if (withoutRules.length > 0) view.problems.push({ code: 'noRules', siteNames: [...new Set(withoutRules)] });
      else if (roundingStep === null) view.problems.push({ code: 'noCompanyRules' });
      if (view.problems.length > 0 || !salary) continue;

      for (const { rules, placements: inPart } of groups.values()) {
        const m = rules.month!;
        const settings = m.rules!.settings;
        const ids = new Set(inPart.map((p) => p.id));
        const places: Record<string, PlaceLabel> = {};
        const base = {
          monthlySalary: salary.monthlySalary.toString(),
          workingDays: m.workingDays!,
          calendar: m.calendar!,
          settings: paySettings(settings),
        };
        let result: PayResult;
        try {
          if (view.source === 'TOTALS') {
            const totals = inPart.map((p) => ({ place: p.id, totals: p.totals! }));
            const issues = checkTotals(totals, m.calendar!, settings.normalHoursPerDay);
            if (issues.length > 0) {
              const siteName = (place: string | null) => inPart.find((p) => p.id === place)?.site.name ?? null;
              view.problems.push({
                code: 'totalsInvalid',
                issues: issues.map((i) => ({ siteName: siteName(i.place), problem: i.problem })),
              });
              continue;
            }
            for (const p of inPart) {
              places[p.id] = { siteName: p.site.name, from: isoDay(p.hiredOn), until: p.leftOn ? isoDay(p.leftOn) : null };
            }
            const routes = Object.fromEntries(inPart.map((p) => [p.id, route(p)]));
            result = calculatePay({ ...base, totals, travel: travel(settings, routes, inPart, travelAmounts) });
          } else {
            const partEntries: DayEntry[] = ownEntries
              .filter((e) => ids.has(e.assignmentId))
              .map((e) => ({
                date: isoDay(e.date),
                place: e.siteId,
                seq: Number(e.seq),
                status: e.status,
                hours: e.hours.toString(),
              }));
            const siteIds = [...new Set(partEntries.map((e) => e.place))];
            const siteNames = await this.siteNames(db, companyId, siteIds);
            for (const siteId of siteIds) places[siteId] = { siteName: siteNames.get(siteId)!, from: null, until: null };
            // A site's route is the worker's route on their placement there; elsewhere none.
            const routes = Object.fromEntries(
              siteIds.map((siteId) => {
                const p = inPart.find((x) => x.siteId === siteId);
                return [siteId, p ? route(p) : null];
              }),
            );
            result = calculatePay({ ...base, entries: partEntries, travel: travel(settings, routes, inPart, travelAmounts) });
          }
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          view.problems.push({ code: 'invalidHours', detail: error.message });
          continue;
        }
        view.parts.push({
          ruleSetSiteName: rules.siteId ? inPart.find((p) => p.siteId === rules.siteId)?.site.name ?? null : null,
          rulesFrom: { year: m.rules!.fromYear, month: m.rules!.fromMonth },
          placementIds: inPart.map((p) => p.id),
          places,
          result,
        });
      }
      if (view.problems.length > 0) view.parts = [];
      else {
        // Parts in the order of their first placement.
        view.parts.sort((a, b) => firstDay(own, a) - firstDay(own, b));
        const ownAdjustments = adjustments.filter((a) => a.workerId === workerId);
        const out = payOut(
          view.parts.map((p) => p.result),
          ownAdjustments.map((a) => ({ id: a.id, type: a.type, amount: a.amount.toString() })),
          roundingStep!,
        );
        view.payOut = {
          ...out,
          adjustments: out.adjustments.map((a) => ({ ...a, note: ownAdjustments.find((o) => o.id === a.id)!.note })),
        };
        view.total = out.total;
      }
    }

    const collator = new Intl.Collator('en');
    workers.sort(
      (a, b) =>
        collator.compare(a.worker.lastName, b.worker.lastName) || collator.compare(a.worker.firstName, b.worker.firstName),
    );
    return workers;
  }

  private async siteNames(db: Db, companyId: string, ids: string[]) {
    const sites = await db.site.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, name: true } });
    return new Map(sites.map((s) => [s.id, s.name]));
  }
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

function firstDay(placements: readonly Placement[], part: PayrollPartView): number {
  const days = placements.filter((p) => part.placementIds.includes(p.id)).map((p) => p.hiredOn.getTime());
  return Math.min(...days);
}

