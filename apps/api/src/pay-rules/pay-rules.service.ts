import { Injectable } from '@nestjs/common';
import type { Prisma, PayrollRules as RulesRow } from '@prisma/client';
import {
  buildMonthCalendar,
  uzbekistanFixedHolidays,
  workingDays,
  type CalendarDay,
  type WorkingDays,
} from '@puantaj/payroll';
import type { FirmPayRules, PayRules } from '@puantaj/schemas';
import { AuditService } from '../audit/audit.service';
import type { CompanyAuthContext } from '../auth/auth.context';
import { notFound } from '../common/api-error';
import { isoDay } from '../common/dates';
import { findFirm } from '../organisation/firms.service';
import { PrismaService } from '../prisma/prisma.service';
import { assertMonthsOpen } from './months';

export interface PayRulesVersionView<R = PayRules> {
  fromYear: number;
  fromMonth: number;
  rules: R;
  setBy: { fullName: string };
  setAt: Date;
}

/**
 * Rules as stored. Rounding is company-wide (AGENTS.md: Pay model): only the company
 * default rule set has a rounding step; site and firm rule sets have null.
 */
export type StoredPayRules = Omit<PayRules, 'payRoundingStep'> & { payRoundingStep: string | null };

/** One month of a rule set, with everything its working days were worked out from. */
export interface MonthRules {
  /** The version that applies, or null when no rules are set for the month yet. */
  rules: { fromYear: number; fromMonth: number; settings: StoredPayRules } | null;
  calendar: CalendarDay[] | null;
  workingDays: WorkingDays | null;
}

type Db = Prisma.TransactionClient | PrismaService;


/**
 * Pay rules of the company default rule set (Settings), versioned by month: a
 * version applies from its month until the next one. Site rule sets will use the
 * same versions once sites exist.
 */
@Injectable()
export class PayRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The company default rule set, or null before its rules are first saved. */
  defaultRuleSet(companyId: string, db: Db = this.prisma) {
    return db.payrollRuleSet.findFirst({ where: { companyId, siteId: null, firmId: null } });
  }

  /** A firm's own rule set, or null before its rules are first saved. */
  firmRuleSet(companyId: string, firmId: string, db: Db = this.prisma) {
    return db.payrollRuleSet.findFirst({ where: { companyId, firmId } });
  }

  /**
   * The rule set that applies at a site: its own (it overrides the company default), or
   * the default. null before any rules are saved.
   */
  async ruleSetForSite(companyId: string, siteId: string, db: Db = this.prisma) {
    return (await db.payrollRuleSet.findFirst({ where: { companyId, siteId } })) ?? this.defaultRuleSet(companyId, db);
  }

  /**
   * The rule set of a placement in a month (AGENTS.md: Firms): its firm's, when the firm has
   * rules for that month, else its site's, else the default. A firm's rules reach only the
   * months from their first version on, so setting them doesn't touch earlier months. Pass
   * firmId null while the company doesn't use firms. Payroll and checks use only this.
   */
  async ruleSetForPlacement(
    companyId: string,
    placement: { siteId: string; firmId: string | null },
    year: number,
    month: number,
    db: Db = this.prisma,
  ) {
    if (placement.firmId) {
      const own = await db.payrollRuleSet.findFirst({
        where: {
          companyId,
          firmId: placement.firmId,
          versions: { some: { OR: [{ fromYear: { lt: year } }, { fromYear: year, fromMonth: { lte: month } }] } },
        },
      });
      if (own) return own;
    }
    return this.ruleSetForSite(companyId, placement.siteId, db);
  }

  async list(companyId: string): Promise<PayRulesVersionView[]> {
    const set = await this.defaultRuleSet(companyId);
    if (!set) return [];
    const rows = await this.prisma.payrollRules.findMany({
      where: { companyId, ruleSetId: set.id },
      include: { setBy: { select: { fullName: true } } },
      orderBy: [{ fromYear: 'desc' }, { fromMonth: 'desc' }],
    });
    return rows.map((row) => ({
      fromYear: row.fromYear,
      fromMonth: row.fromMonth,
      rules: defaultRules(row),
      setBy: row.setBy,
      setAt: row.setAt,
    }));
  }

  /** A firm's own rules, newest first; none: its placements use their site's or the default. */
  async listFirm(companyId: string, firmId: string): Promise<PayRulesVersionView<FirmPayRules>[]> {
    await findFirm(this.prisma, companyId, firmId, firmId);
    const set = await this.firmRuleSet(companyId, firmId);
    if (!set) return [];
    const rows = await this.prisma.payrollRules.findMany({
      where: { companyId, ruleSetId: set.id },
      include: { setBy: { select: { fullName: true } } },
      orderBy: [{ fromYear: 'desc' }, { fromMonth: 'desc' }],
    });
    return rows.map((row) => {
      const { payRoundingStep: _, ...rules } = toPayRules(row);
      return { fromYear: row.fromYear, fromMonth: row.fromMonth, rules, setBy: row.setBy, setAt: row.setAt };
    });
  }

  /** Saves a firm's rules from a month on, as set() does for the company default. No rounding step: it is company-wide. */
  async setFirm(auth: CompanyAuthContext, firmId: string, from: { year: number; month: number }, rules: FirmPayRules): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      await findFirm(tx, companyId, firmId, firmId);
      const set =
        (await this.firmRuleSet(companyId, firmId, tx)) ?? (await tx.payrollRuleSet.create({ data: { companyId, firmId } }));
      await assertMonthsOpen(tx, companyId, from, await this.nextVersionStart(tx, set.id, from));

      const key = { ruleSetId_fromYear_fromMonth: { ruleSetId: set.id, fromYear: from.year, fromMonth: from.month } };
      const before = await tx.payrollRules.findUnique({ where: key });
      const data = { ...toColumns({ ...rules, payRoundingStep: null }), setById: auth.user.id, setAt: new Date() };
      await tx.payrollRules.upsert({
        where: key,
        create: { companyId, ruleSetId: set.id, fromYear: from.year, fromMonth: from.month, ...data },
        update: data,
      });
      await this.audit.record(
        {
          action: 'payRules.set',
          companyId,
          auth,
          entityType: 'PayrollRuleSet',
          entityId: set.id,
          data: {
            firmId,
            fromYear: from.year,
            fromMonth: from.month,
            before: before ? (toPayRules(before) as unknown as Prisma.InputJsonObject) : null,
            after: rules as unknown as Prisma.InputJsonObject,
          },
        },
        tx,
      );
    });
  }

  /** Removes a version of a firm's rules: its months fall back to the version before, or the site's or default rules. */
  async removeFirm(auth: CompanyAuthContext, firmId: string, from: { year: number; month: number }): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      await findFirm(tx, companyId, firmId, firmId);
      const set = await this.firmRuleSet(companyId, firmId, tx);
      const key = set && {
        ruleSetId_fromYear_fromMonth: { ruleSetId: set.id, fromYear: from.year, fromMonth: from.month },
      };
      const row = key && (await tx.payrollRules.findUnique({ where: key }));
      if (!set || !key || !row) throw notFound('payRules.notFound');
      await assertMonthsOpen(tx, companyId, from, await this.nextVersionStart(tx, set.id, from));
      await tx.payrollRules.delete({ where: key });
      await this.audit.record(
        {
          action: 'payRules.delete',
          companyId,
          auth,
          entityType: 'PayrollRuleSet',
          entityId: set.id,
          data: {
            firmId,
            fromYear: from.year,
            fromMonth: from.month,
            before: toPayRules(row) as unknown as Prisma.InputJsonObject,
          },
        },
        tx,
      );
    });
  }

  /** Saves the rules that apply from a month on, replacing that month's version if any. */
  async set(auth: CompanyAuthContext, from: { year: number; month: number }, rules: PayRules): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const set =
        (await this.defaultRuleSet(companyId, tx)) ?? (await tx.payrollRuleSet.create({ data: { companyId } }));
      await assertMonthsOpen(tx, companyId, from, await this.nextVersionStart(tx, set.id, from));

      const key = { ruleSetId_fromYear_fromMonth: { ruleSetId: set.id, fromYear: from.year, fromMonth: from.month } };
      const before = await tx.payrollRules.findUnique({ where: key });
      const data = { ...toColumns(rules), setById: auth.user.id, setAt: new Date() };
      await tx.payrollRules.upsert({
        where: key,
        create: { companyId, ruleSetId: set.id, fromYear: from.year, fromMonth: from.month, ...data },
        update: data,
      });
      await this.audit.record(
        {
          action: 'payRules.set',
          companyId,
          auth,
          entityType: 'PayrollRuleSet',
          entityId: set.id,
          data: {
            fromYear: from.year,
            fromMonth: from.month,
            before: before ? (defaultRules(before) as unknown as Prisma.InputJsonObject) : null,
            after: rules as unknown as Prisma.InputJsonObject,
          },
        },
        tx,
      );
    });
  }

  /** Removes the version from a month: the months it covered fall back to the version before it. */
  async remove(auth: CompanyAuthContext, from: { year: number; month: number }): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const set = await this.defaultRuleSet(companyId, tx);
      const key = set && {
        ruleSetId_fromYear_fromMonth: { ruleSetId: set.id, fromYear: from.year, fromMonth: from.month },
      };
      const row = key && (await tx.payrollRules.findUnique({ where: key }));
      if (!set || !key || !row) throw notFound('payRules.notFound');
      await assertMonthsOpen(tx, companyId, from, await this.nextVersionStart(tx, set.id, from));
      await tx.payrollRules.delete({ where: key });
      await this.audit.record(
        {
          action: 'payRules.delete',
          companyId,
          auth,
          entityType: 'PayrollRuleSet',
          entityId: set.id,
          data: {
            fromYear: from.year,
            fromMonth: from.month,
            before: defaultRules(row) as unknown as Prisma.InputJsonObject,
          },
        },
        tx,
      );
    });
  }

  /**
   * The rules, calendar and working days of a month of a rule set. The one place that
   * works these out, so Settings and payroll always agree.
   */
  async month(companyId: string, ruleSetId: string, year: number, month: number, db: Db = this.prisma): Promise<MonthRules> {
    const version = await db.payrollRules.findFirst({
      where: {
        companyId,
        ruleSetId,
        OR: [{ fromYear: { lt: year } }, { fromYear: year, fromMonth: { lte: month } }],
      },
      orderBy: [{ fromYear: 'desc' }, { fromMonth: 'desc' }],
    });
    if (!version) return { rules: null, calendar: null, workingDays: null };

    const settings = toPayRules(version);
    const calendar = await this.calendar(companyId, year, month, settings.restWeekdays, db);
    const override = await db.workingDaysOverride.findFirst({
      where: { companyId, ruleSetId, year, month },
      orderBy: { seq: 'desc' },
    });
    return {
      rules: { fromYear: version.fromYear, fromMonth: version.fromMonth, settings },
      calendar,
      workingDays: workingDays(calendar, override?.workingDays ?? null),
    };
  }

  /** The month's days: Uzbekistan's fixed holidays plus the holidays the company entered. */
  async calendar(companyId: string, year: number, month: number, restWeekdays: readonly number[], db: Db = this.prisma) {
    const entered = await db.holiday.findMany({
      where: {
        companyId,
        date: { gte: new Date(Date.UTC(year, month - 1, 1)), lt: new Date(Date.UTC(year, month, 1)) },
      },
    });
    const prefix = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-`;
    const fixed = uzbekistanFixedHolidays(year)
      .map((h) => h.date)
      .filter((date) => date.startsWith(prefix));
    return buildMonthCalendar(year, month, {
      restWeekdays,
      holidays: [...fixed, ...entered.filter((h) => h.kind !== 'WORKING_DAY').map((h) => isoDay(h.date))],
      extraWorkdays: entered.filter((h) => h.kind === 'WORKING_DAY').map((h) => isoDay(h.date)),
    });
  }

  /** Start of the version after `from`, i.e. the first month a version at `from` doesn't reach. */
  private async nextVersionStart(db: Db, ruleSetId: string, from: { year: number; month: number }) {
    const next = await db.payrollRules.findFirst({
      where: {
        ruleSetId,
        OR: [{ fromYear: { gt: from.year } }, { fromYear: from.year, fromMonth: { gt: from.month } }],
      },
      orderBy: [{ fromYear: 'asc' }, { fromMonth: 'asc' }],
    });
    return next && { year: next.fromYear, month: next.fromMonth };
  }
}

/** A version of the company default rule set, which always has a rounding step. */
function defaultRules(row: RulesRow): PayRules {
  const rules = toPayRules(row);
  if (rules.payRoundingStep === null) throw new Error(`Rules ${row.id} of a company default rule set have no rounding step`);
  return { ...rules, payRoundingStep: rules.payRoundingStep };
}

function toPayRules(row: RulesRow): StoredPayRules {
  return {
    restWeekdays: [...row.restWeekdays].sort((a, b) => a - b),
    normalHoursPerDay: row.normalHoursPerDay.toString(),
    overtimeMultiplier: row.overtimeMultiplier.toString(),
    restDayMultiplier: row.restDayMultiplier.toString(),
    holidayMultiplier: row.holidayMultiplier.toString(),
    absence: {
      LEAVE: { paid: row.leavePaid, hoursPerDay: row.leaveHoursPerDay?.toString() ?? null },
      SICK: { paid: row.sickPaid, hoursPerDay: row.sickHoursPerDay?.toString() ?? null },
      TRAVEL: { paid: row.travelDayPaid, hoursPerDay: row.travelDayHoursPerDay?.toString() ?? null },
    },
    travelPayMode: row.travelPayMode,
    payRoundingStep: row.payRoundingStep?.toString() ?? null,
  };
}

function toColumns(rules: StoredPayRules) {
  return {
    restWeekdays: rules.restWeekdays,
    normalHoursPerDay: rules.normalHoursPerDay,
    overtimeMultiplier: rules.overtimeMultiplier,
    restDayMultiplier: rules.restDayMultiplier,
    holidayMultiplier: rules.holidayMultiplier,
    leavePaid: rules.absence.LEAVE.paid,
    leaveHoursPerDay: rules.absence.LEAVE.hoursPerDay,
    sickPaid: rules.absence.SICK.paid,
    sickHoursPerDay: rules.absence.SICK.hoursPerDay,
    travelDayPaid: rules.absence.TRAVEL.paid,
    travelDayHoursPerDay: rules.absence.TRAVEL.hoursPerDay,
    travelPayMode: rules.travelPayMode,
    payRoundingStep: rules.payRoundingStep,
  };
}
