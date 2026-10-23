import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  calculatePay,
  checkTotals,
  totalOfParts,
  type DayEntry,
  type PayResult,
  type PaySettings,
  type TotalsProblem,
  type TravelInput,
} from '@puantaj/payroll';
import type { PayRules, YearMonth } from '@puantaj/schemas';
import type { CompanyAuthContext } from '../auth/auth.context';
import { inMonth, isoDay, monthSpan } from '../common/dates';
import { seesPlacement } from '../organisation/access';
import { SALARY_ORDER } from '../organisation/workers.service';
import { PayRulesService, type MonthRules } from '../pay-rules/pay-rules.service';
import { PrismaService } from '../prisma/prisma.service';
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

export interface PayrollWorkerView {
  worker: { id: string; lastName: string; firstName: string; patronymic: string | null; position: string | null };
  salary: { fromYear: number; fromMonth: number; monthlySalary: string } | null;
  /** Where the hours came from, or null when there are none */
  source: 'DAILY' | 'TOTALS' | null;
  /** Empty while there are problems */
  parts: PayrollPartView[];
  /** Sum of the parts; null while there are problems */
  total: string | null;
  problems: PayrollProblem[];
}

export interface PayrollMonthView {
  year: number;
  month: number;
  locked: boolean;
  /** Sum of the workers that could be paid */
  total: string;
  workers: PayrollWorkerView[];
}

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
 * site, and each group is a part paid and rounded under its own rules.
 */
@Injectable()
export class PayrollService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: PayRulesService,
  ) {}

  async month(auth: CompanyAuthContext, { year, month }: YearMonth): Promise<PayrollMonthView> {
    const companyId = auth.company.id;
    const { first, last } = monthSpan(year, month);
    const [rows, locked, period] = await Promise.all([
      this.prisma.assignment.findMany({
        where: { AND: [{ companyId }, inMonth(year, month)] },
        include: {
          ...PLACEMENT_INCLUDE,
          monthlyHours: { where: { year, month }, orderBy: { seq: 'desc' }, take: 1 },
        },
        orderBy: { hiredOn: 'asc' },
      }),
      this.prisma.payrollPeriod.count({ where: { companyId, year, month, status: 'LOCKED' } }),
      this.prisma.payrollPeriod.findUnique({ where: { companyId_year_month: { companyId, year, month } } }),
    ]);

    // Project managers see the workers with a placement on their sites this month.
    const visible = new Set(rows.filter((p) => seesPlacement(auth, p.siteId, p.teamId)).map((p) => p.workerId));
    const placements: Placement[] = rows
      .filter((p) => visible.has(p.workerId))
      .map(({ monthlyHours, ...p }) => ({ ...p, totals: monthlyHours[0] ? toTotals(monthlyHours[0]) : null }));
    const assignmentIds = placements.map((p) => p.id);
    const workerIds = [...visible];

    const [salaries, entries, travelAdjustments] = await Promise.all([
      this.prisma.salary.findMany({
        where: {
          companyId,
          workerId: { in: workerIds },
          OR: [{ fromYear: { lt: year } }, { fromYear: year, fromMonth: { lte: month } }],
        },
        orderBy: SALARY_ORDER,
      }),
      this.prisma.timesheetEntry.findMany({
        where: { companyId, assignmentId: { in: assignmentIds }, date: { gte: first, lte: last } },
      }),
      period
        ? this.prisma.adjustment.findMany({
            where: { companyId, periodId: period.id, type: 'TRAVEL', assignmentId: { in: assignmentIds } },
          })
        : [],
    ]);

    const monthRules = new Map<string, Promise<{ ruleSetId: string | null; siteId: string | null; month: MonthRules | null }>>();
    const rulesAt = (siteId: string) => {
      let found = monthRules.get(siteId);
      if (!found) {
        found = this.rules.ruleSetForSite(companyId, siteId).then(async (set) => ({
          ruleSetId: set?.id ?? null,
          siteId: set?.siteId ?? null,
          month: set ? await this.rules.month(companyId, set.id, year, month) : null,
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
            result = calculatePay({ ...base, totals, travel: travel(settings, routes, inPart, travelAdjustments) });
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
            const siteNames = await this.siteNames(companyId, siteIds);
            for (const siteId of siteIds) places[siteId] = { siteName: siteNames.get(siteId)!, from: null, until: null };
            // A site's route is the worker's route on their placement there; elsewhere none.
            const routes = Object.fromEntries(
              siteIds.map((siteId) => {
                const p = inPart.find((x) => x.siteId === siteId);
                return [siteId, p ? route(p) : null];
              }),
            );
            result = calculatePay({ ...base, entries: partEntries, travel: travel(settings, routes, inPart, travelAdjustments) });
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
        view.total = totalOfParts(view.parts.map((p) => p.result));
      }
    }

    const collator = new Intl.Collator('en');
    workers.sort(
      (a, b) =>
        collator.compare(a.worker.lastName, b.worker.lastName) || collator.compare(a.worker.firstName, b.worker.firstName),
    );
    return {
      year,
      month,
      locked: locked > 0,
      total: totalOfParts(
        workers.flatMap((w) => (w.total === null ? [] : w.parts.map((p) => p.result))),
      ),
      workers,
    };
  }

  private async siteNames(companyId: string, ids: string[]) {
    const sites = await this.prisma.site.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, name: true } });
    return new Map(sites.map((s) => [s.id, s.name]));
  }
}

/** Pay rules (Settings) as the engine takes them. Normal hours are always paid at × 1. */
function paySettings(rules: PayRules): PaySettings {
  return {
    normalHoursPerDay: rules.normalHoursPerDay,
    multipliers: {
      NORMAL: '1',
      OVERTIME: rules.overtimeMultiplier,
      REST_DAY: rules.restDayMultiplier,
      HOLIDAY: rules.holidayMultiplier,
    },
    absence: rules.absence,
    payRoundingStep: rules.payRoundingStep,
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
  rules: PayRules,
  routes: Record<string, ReturnType<typeof route>>,
  inPart: readonly Placement[],
  adjustments: readonly { assignmentId: string; amount: Prisma.Decimal }[],
): TravelInput | null {
  if (rules.travelPayMode === 'PER_DAY_WORKED') return { kind: 'PER_DAY_WORKED', routes };
  if (rules.travelPayMode === 'MONTHLY_AMOUNT') {
    const own = adjustments.filter((a) => inPart.some((p) => p.id === a.assignmentId));
    if (own.length === 0) return null;
    const sum = own.reduce((acc, a) => acc.plus(a.amount), new Prisma.Decimal(0));
    return { kind: 'MONTHLY_AMOUNT', amount: sum.toFixed(2) };
  }
  return null;
}

function firstDay(placements: readonly Placement[], part: PayrollPartView): number {
  const days = placements.filter((p) => part.placementIds.includes(p.id)).map((p) => p.hiredOn.getTime());
  return Math.min(...days);
}

