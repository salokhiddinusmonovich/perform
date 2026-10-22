import { Injectable } from '@nestjs/common';
import type { Prisma, PayrollRules as RulesRow } from '@prisma/client';
import {
  buildMonthCalendar,
  uzbekistanFixedHolidays,
  workingDays,
  type CalendarDay,
  type WorkingDays,
} from '@puantaj/payroll';
import type { PayRules } from '@puantaj/schemas';
import { AuditService } from '../audit/audit.service';
import type { CompanyAuthContext } from '../auth/auth.context';
import { notFound } from '../common/api-error';
import { isoDay } from '../common/dates';
import { PrismaService } from '../prisma/prisma.service';
import { assertMonthsOpen } from './months';

export interface PayRulesVersionView {
  fromYear: number;
  fromMonth: number;
  rules: PayRules;
  setBy: { fullName: string };
  setAt: Date;
}

/** One month of a rule set, with everything its working days were worked out from. */
export interface MonthRules {
  /** The version that applies, or null when no rules are set for the month yet. */
  rules: { fromYear: number; fromMonth: number; settings: PayRules } | null;
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
    return db.payrollRuleSet.findFirst({ where: { companyId, siteId: null } });
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
      rules: toPayRules(row),
      setBy: row.setBy,
      setAt: row.setAt,
    }));
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
            before: before ? (toPayRules(before) as unknown as Prisma.InputJsonObject) : null,
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
            before: toPayRules(row) as unknown as Prisma.InputJsonObject,
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

function toPayRules(row: RulesRow): PayRules {
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
    payRoundingStep: row.payRoundingStep.toString(),
  };
}

function toColumns(rules: PayRules) {
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
