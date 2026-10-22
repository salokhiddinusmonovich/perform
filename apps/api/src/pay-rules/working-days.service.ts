import { Injectable } from '@nestjs/common';
import { missingMovingHolidays, type MovingHoliday } from '@puantaj/payroll';
import type { WorkingDaysOverride } from '@puantaj/schemas';
import { AuditService } from '../audit/audit.service';
import type { CompanyAuthContext } from '../auth/auth.context';
import { badRequest, conflict } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { assertMonthsOpen } from './months';
import { PayRulesService } from './pay-rules.service';

export interface OverrideView {
  /** null = back to the calculated value */
  workingDays: number | null;
  reason: string | null;
  setBy: { fullName: string };
  setAt: Date;
}

export interface WorkingDaysMonthView {
  month: number;
  /** Month the rules in force start from; null = no rules for this month yet. */
  rulesFrom: { year: number; month: number } | null;
  calculated: number | null;
  override: number | null;
  effective: number | null;
  locked: boolean;
  /** Every override of the month, newest first. */
  history: OverrideView[];
}

export interface WorkingDaysYearView {
  year: number;
  missingMovingHolidays: MovingHoliday[];
  months: WorkingDaysMonthView[];
}

/**
 * Working days per month of the company default rule set: calculated from its rest
 * weekdays and the holidays, with overrides by an owner, admin or accountant. Overrides
 * are only ever added (the accountant can't edit); the newest counts.
 */
@Injectable()
export class WorkingDaysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: PayRulesService,
    private readonly audit: AuditService,
  ) {}

  async year(companyId: string, year: number): Promise<WorkingDaysYearView> {
    const set = await this.rules.defaultRuleSet(companyId);
    const [holidays, locked, overrides] = await Promise.all([
      this.prisma.holiday.findMany({
        where: { companyId, date: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) } },
        select: { kind: true },
      }),
      this.prisma.payrollPeriod.findMany({ where: { companyId, year, status: 'LOCKED' }, select: { month: true } }),
      set
        ? this.prisma.workingDaysOverride.findMany({
            where: { companyId, ruleSetId: set.id, year },
            include: { setBy: { select: { fullName: true } } },
            orderBy: { seq: 'desc' },
          })
        : [],
    ]);

    const months: WorkingDaysMonthView[] = [];
    for (let month = 1; month <= 12; month++) {
      const m = set ? await this.rules.month(companyId, set.id, year, month) : null;
      months.push({
        month,
        rulesFrom: m?.rules ? { year: m.rules.fromYear, month: m.rules.fromMonth } : null,
        calculated: m?.workingDays?.calculated ?? null,
        override: m?.workingDays?.override ?? null,
        effective: m?.workingDays?.effective ?? null,
        locked: locked.some((p) => p.month === month),
        history: overrides
          .filter((o) => o.month === month)
          .map((o) => ({ workingDays: o.workingDays, reason: o.reason, setBy: o.setBy, setAt: o.setAt })),
      });
    }
    return { year, missingMovingHolidays: missingMovingHolidays(holidays.map((h) => h.kind)), months };
  }

  async override(
    auth: CompanyAuthContext,
    { year, month }: { year: number; month: number },
    input: WorkingDaysOverride,
  ): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      await assertMonthsOpen(tx, companyId, { year, month });
      const set = await this.rules.defaultRuleSet(companyId, tx);
      const current = set && (await this.rules.month(companyId, set.id, year, month, tx));
      if (!set || !current?.calendar || !current.workingDays) throw conflict('payRules.notSet');
      if (input.workingDays !== null && input.workingDays > current.calendar.length) {
        throw badRequest('validation', { issues: [{ path: 'workingDays', message: 'validation.workingDaysRange' }] });
      }
      if (input.workingDays === current.workingDays.override) throw conflict('workingDays.unchanged');

      const row = await tx.workingDaysOverride.create({
        data: {
          companyId,
          ruleSetId: set.id,
          year,
          month,
          workingDays: input.workingDays,
          reason: input.reason,
          setById: auth.user.id,
        },
      });
      await this.audit.record(
        {
          action: 'workingDays.override',
          companyId,
          actorUserId: auth.user.id,
          entityType: 'WorkingDaysOverride',
          entityId: row.id,
          data: {
            year,
            month,
            calculated: current.workingDays.calculated,
            from: current.workingDays.override,
            to: input.workingDays,
            reason: input.reason,
          },
          ip: auth.ip,
        },
        tx,
      );
    });
  }
}
