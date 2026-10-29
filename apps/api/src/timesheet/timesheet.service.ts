import { Injectable } from '@nestjs/common';
import { Prisma, type DayStatus } from '@prisma/client';
import { MAX_HOURS_PER_DAY, type DayKind } from '@puantaj/payroll';
import type { TimesheetEntry, YearMonth } from '@puantaj/schemas';
import { AuditService } from '../audit/audit.service';
import type { CompanyAuthContext } from '../auth/auth.context';
import { conflict, forbidden, notFound } from '../common/api-error';
import { currentOn, dayToDate, inMonth, isoDay, monthOfDay, monthSpan } from '../common/dates';
import { entersHoursAt, seesPlacement, visibleSites } from '../organisation/access';
import { assertMonthsOpen, lockWorkerMonth } from '../pay-rules/months';
import { PayRulesService } from '../pay-rules/pay-rules.service';
import { timesheetIn } from '../platform/company-plan';
import { PrismaService } from '../prisma/prisma.service';
import { TimesheetSettingsService } from './timesheet-settings.service';

export interface TimesheetEntryView {
  id: string;
  date: string;
  status: DayStatus;
  /** Decimal string; "0" unless WORKED */
  hours: string;
  note: string | null;
  /** Send it back to change or remove the entry: a stale version is refused. */
  version: number;
  /** Written by an Excel import: changed only by importing the month again */
  imported: boolean;
  updatedBy: { fullName: string };
  updatedAt: Date;
}

/** One worker at one team of the site (or no team), with their entries there. */
export interface TimesheetRowView {
  worker: { id: string; lastName: string; firstName: string; patronymic: string | null; position: string | null };
  teamId: string | null;
  teamName: string | null;
  /** Spans the worker is employed in the month, at any site: days outside them take no entries. */
  employed: { from: string; until: string | null }[];
  /** Hours for this worker-month come from monthly totals, so no daily entries can be added. */
  hasMonthlyTotals: boolean;
  /** Hours for this worker-month come from an Excel import, so they aren't entered here. */
  hasImportedHours: boolean;
  /** The caller may enter hours on this row (Settings and their sites or teams). */
  canEnter: boolean;
  entries: TimesheetEntryView[];
}

export interface TimesheetMonthView {
  year: number;
  month: number;
  site: { id: string; name: string; isActive: boolean };
  locked: boolean;
  /** This month's plan has the Timesheet module; without it no hours are entered. */
  timesheetModule: boolean;
  /** Kind of each day under the site's rules; null while no rules are set for the month. */
  calendar: { date: string; kind: DayKind }[] | null;
  rows: TimesheetRowView[];
}

type Tx = Prisma.TransactionClient;

const ENTRY_INCLUDE = {
  assignment: { select: { workerId: true } },
  updatedBy: { select: { fullName: true } },
} as const satisfies Prisma.TimesheetEntryInclude;

type EntryRow = Prisma.TimesheetEntryGetPayload<{ include: typeof ENTRY_INCLUDE }>;

const WORKER_SELECT = { id: true, lastName: true, firstName: true, patronymic: true, position: true } as const;

function entryView(e: EntryRow): TimesheetEntryView {
  return {
    id: e.id,
    date: isoDay(e.date),
    status: e.status,
    hours: e.hours.toString(),
    note: e.note,
    version: e.version,
    imported: e.importId !== null,
    updatedBy: e.updatedBy,
    updatedAt: e.updatedAt,
  };
}

/** What an entry says, as the audit log records it. */
const content = (e: { status: DayStatus; hours: Prisma.Decimal | string; note: string | null }) => ({
  status: e.status,
  hours: e.hours.toString(),
  note: e.note,
});

/**
 * Daily hours, one entry per worker, day and site/team (AGENTS.md: Hour entry). Who may
 * enter them follows the company's settings and the caller's sites or teams
 * (entersHoursAt). Writes are made for the mobile app too: the client names the entry
 * by its own UUID, a retry of the same write changes nothing, and a write based on an
 * old version is refused.
 */
@Injectable()
export class TimesheetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: PayRulesService,
    private readonly settings: TimesheetSettingsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * A site's month: the workers placed on it and anyone with entries there, each team
   * they work in a row of its own. Only what the caller sees (their sites or teams).
   */
  async month(auth: CompanyAuthContext, { year, month }: YearMonth, siteId: string): Promise<TimesheetMonthView> {
    const companyId = auth.company.id;
    const site = await this.prisma.site.findFirst({ where: { AND: [visibleSites(auth), { id: siteId }] } });
    if (!site) throw notFound('site.notFound');
    const { first, last } = monthSpan(year, month);

    const [placements, entries, locked, entryRoles, calendar, timesheetModule] = await Promise.all([
      this.prisma.assignment.findMany({
        where: { AND: [{ companyId, siteId }, inMonth(year, month)] },
        include: { worker: { select: WORKER_SELECT }, team: { select: { name: true } } },
      }),
      this.prisma.timesheetEntry.findMany({
        where: { companyId, siteId, date: { gte: first, lte: last } },
        include: {
          ...ENTRY_INCLUDE,
          assignment: { select: { workerId: true, worker: { select: WORKER_SELECT } } },
          team: { select: { name: true } },
        },
        orderBy: { date: 'asc' },
      }),
      this.prisma.payrollPeriod.count({ where: { companyId, year, month, status: 'LOCKED' } }),
      this.settings.entryRoles(companyId),
      this.calendar(companyId, siteId, year, month),
      timesheetIn(this.prisma, companyId, { year, month }),
    ]);

    const rows = new Map<string, TimesheetRowView>();
    const rowFor = (worker: TimesheetRowView['worker'], teamId: string | null, teamName: string | null) => {
      const key = `${worker.id}:${teamId ?? ''}`;
      let row = rows.get(key);
      if (!row) {
        row = {
          worker,
          teamId,
          teamName,
          employed: [],
          hasMonthlyTotals: false,
          hasImportedHours: false,
          canEnter: timesheetModule && locked === 0 && entersHoursAt(auth, entryRoles, siteId, teamId),
          entries: [],
        };
        rows.set(key, row);
      }
      return row;
    };
    for (const p of placements) {
      if (seesPlacement(auth, p.siteId, p.teamId)) rowFor(p.worker, p.teamId, p.team?.name ?? null);
    }
    for (const e of entries) {
      if (!seesPlacement(auth, e.siteId, e.teamId)) continue;
      rowFor(e.assignment.worker, e.teamId, e.team?.name ?? null).entries.push(entryView(e));
    }

    const workerIds = [...new Set([...rows.values()].map((r) => r.worker.id))];
    const [spans, totals, imported] = await Promise.all([
      this.prisma.assignment.findMany({
        where: { AND: [{ companyId, workerId: { in: workerIds } }, inMonth(year, month)] },
        select: { workerId: true, hiredOn: true, leftOn: true },
        orderBy: { hiredOn: 'asc' },
      }),
      this.prisma.monthlyHours.findMany({
        where: { companyId, year, month, assignment: { workerId: { in: workerIds } } },
        distinct: ['assignmentId'],
        select: { assignment: { select: { workerId: true } } },
      }),
      this.prisma.timesheetEntry.findMany({
        where: { companyId, importId: { not: null }, date: { gte: first, lte: last }, assignment: { workerId: { in: workerIds } } },
        distinct: ['assignmentId'],
        select: { assignment: { select: { workerId: true } } },
      }),
    ]);
    const withTotals = new Set(totals.map((t) => t.assignment.workerId));
    const withImport = new Set(imported.map((t) => t.assignment.workerId));
    for (const row of rows.values()) {
      row.employed = spans
        .filter((s) => s.workerId === row.worker.id)
        .map((s) => ({ from: isoDay(s.hiredOn), until: s.leftOn ? isoDay(s.leftOn) : null }));
      row.hasMonthlyTotals = withTotals.has(row.worker.id);
      row.hasImportedHours = withImport.has(row.worker.id);
      if (row.hasImportedHours) row.canEnter = false;
    }

    const collator = new Intl.Collator('en');
    const sorted = [...rows.values()].sort(
      (a, b) =>
        collator.compare(a.worker.lastName, b.worker.lastName) ||
        collator.compare(a.worker.firstName, b.worker.firstName) ||
        collator.compare(a.teamName ?? '', b.teamName ?? ''),
    );
    return {
      year,
      month,
      site: { id: site.id, name: site.name, isActive: site.isActive },
      locked: locked > 0,
      timesheetModule,
      calendar,
      rows: sorted,
    };
  }

  /**
   * Creates or changes the entry with this id. The same write sent again (a retry)
   * returns the entry unchanged; a change must name the version it was based on.
   */
  async write(auth: CompanyAuthContext, id: string, input: TimesheetEntry): Promise<TimesheetEntryView> {
    const companyId = auth.company.id;
    const { year, month } = monthOfDay(input.date);
    return this.prisma.$transaction(async (tx) => {
      const entryRoles = await this.settings.entryRoles(companyId, tx);
      if (!entersHoursAt(auth, entryRoles, input.siteId, input.teamId)) throw forbidden();
      await assertTimesheetIn(tx, companyId, { year, month });
      await assertMonthsOpen(tx, companyId, { year, month });
      await lockWorkerMonth(tx, input.workerId, year, month);

      const existing = await tx.timesheetEntry.findUnique({ where: { id }, include: ENTRY_INCLUDE });
      if (existing && existing.companyId !== companyId) throw notFound('timesheet.entryNotFound');
      if (existing) {
        const sameCell =
          existing.assignment.workerId === input.workerId &&
          isoDay(existing.date) === input.date &&
          existing.siteId === input.siteId &&
          existing.teamId === input.teamId;
        if (!sameCell) throw conflict('timesheet.entryMismatch');
        if (existing.importId) throw conflict('timesheet.imported');
        const before = content(existing);
        if (before.status === input.status && before.hours === input.hours && before.note === input.note) {
          return entryView(existing);
        }
        if (input.version !== existing.version) throw conflict('timesheet.staleVersion', { current: entryView(existing) });
        await this.assertDayFits(tx, companyId, input, id);
        const updated = await tx.timesheetEntry.update({
          where: { id },
          data: {
            status: input.status,
            hours: input.hours,
            note: input.note,
            version: { increment: 1 },
            updatedById: auth.user.id,
          },
          include: ENTRY_INCLUDE,
        });
        await this.record(tx, auth, 'timesheetEntry.update', updated, { from: before, to: content(updated) });
        return entryView(updated);
      }

      // The client changed an entry that has been removed meanwhile.
      if (input.version !== undefined) throw conflict('timesheet.staleVersion', { current: null });
      await this.assertPlace(tx, companyId, input.siteId, input.teamId);
      const worker = await tx.worker.findFirst({ where: { id: input.workerId, companyId }, select: { id: true } });
      if (!worker) throw notFound('worker.notFound');
      // The worker's employment that day: its pay rules apply, wherever the hours were worked.
      const placement = await tx.assignment.findFirst({
        where: { companyId, workerId: input.workerId, ...currentOn(input.date) },
        orderBy: { hiredOn: 'desc' },
      });
      if (!placement) throw conflict('timesheet.notEmployed');
      const totals = await tx.monthlyHours.count({ where: { companyId, year, month, assignment: { workerId: input.workerId } } });
      if (totals > 0) throw conflict('hours.monthlyTotalsEntered');
      const { first, last } = monthSpan(year, month);
      const imported = await tx.timesheetEntry.count({
        where: { companyId, importId: { not: null }, date: { gte: first, lte: last }, assignment: { workerId: input.workerId } },
      });
      if (imported > 0) throw conflict('timesheet.imported');
      const taken = await tx.timesheetEntry.findFirst({
        where: { assignmentId: placement.id, date: dayToDate(input.date), siteId: input.siteId, teamId: input.teamId },
        include: ENTRY_INCLUDE,
      });
      if (taken) throw conflict('timesheet.entryExists', { current: entryView(taken) });
      await this.assertDayFits(tx, companyId, input, null);

      const created = await tx.timesheetEntry.create({
        data: {
          id,
          companyId,
          periodId: await openPeriod(tx, companyId, year, month),
          assignmentId: placement.id,
          siteId: input.siteId,
          teamId: input.teamId,
          date: dayToDate(input.date),
          status: input.status,
          hours: input.hours,
          note: input.note,
          createdById: auth.user.id,
          updatedById: auth.user.id,
        },
        include: ENTRY_INCLUDE,
      });
      await this.record(tx, auth, 'timesheetEntry.create', created, { to: content(created) });
      return entryView(created);
    });
  }

  /** Removes an entry. Removing one that is already gone (a retry) succeeds. */
  async remove(auth: CompanyAuthContext, id: string, version: number): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.timesheetEntry.findFirst({ where: { id, companyId }, include: ENTRY_INCLUDE });
      if (!found) return;
      const entryRoles = await this.settings.entryRoles(companyId, tx);
      if (!entersHoursAt(auth, entryRoles, found.siteId, found.teamId)) throw forbidden();
      const { year, month } = monthOfDay(isoDay(found.date));
      await assertTimesheetIn(tx, companyId, { year, month });
      await assertMonthsOpen(tx, companyId, { year, month });
      await lockWorkerMonth(tx, found.assignment.workerId, year, month);
      // Read again under the lock: a write may have changed it meanwhile.
      const existing = await tx.timesheetEntry.findFirst({ where: { id, companyId }, include: ENTRY_INCLUDE });
      if (!existing) return;
      if (existing.version !== version) throw conflict('timesheet.staleVersion', { current: entryView(existing) });
      if (existing.importId) throw conflict('timesheet.imported');
      await tx.timesheetEntry.delete({ where: { id } });
      await this.record(tx, auth, 'timesheetEntry.delete', existing, { from: content(existing) });
    });
  }

  /** The site (and team) must exist in the company and be open for new entries. */
  private async assertPlace(tx: Tx, companyId: string, siteId: string, teamId: string | null) {
    const site = await tx.site.findFirst({ where: { id: siteId, companyId } });
    if (!site) throw notFound('site.notFound');
    if (!site.isActive) throw conflict('site.inactive');
    if (teamId) {
      const team = await tx.team.findFirst({ where: { id: teamId, companyId, siteId } });
      if (!team) throw notFound('team.notFound');
      if (!team.isActive) throw conflict('team.inactive');
    }
  }

  /**
   * The worker's day with this entry in it must make sense (as @puantaj/payroll checks
   * it): an absence is the whole day, so it is the day's only entry, and the hours of a
   * split day add up to at most 24.
   */
  private async assertDayFits(tx: Tx, companyId: string, input: TimesheetEntry, excludeId: string | null) {
    const others = await tx.timesheetEntry.findMany({
      where: {
        companyId,
        date: dayToDate(input.date),
        assignment: { workerId: input.workerId },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { status: true, hours: true },
    });
    if (others.length === 0) return;
    if (input.status !== 'WORKED' || others.some((o) => o.status !== 'WORKED')) throw conflict('timesheet.wholeDay');
    const total = others.reduce((sum, o) => sum.plus(o.hours), new Prisma.Decimal(input.hours));
    if (total.greaterThan(MAX_HOURS_PER_DAY)) throw conflict('timesheet.dayTooManyHours');
  }

  private async calendar(companyId: string, siteId: string, year: number, month: number) {
    const set = await this.rules.ruleSetForSite(companyId, siteId);
    const m = set && (await this.rules.month(companyId, set.id, year, month));
    return m?.calendar?.map((d) => ({ date: d.date, kind: d.kind })) ?? null;
  }

  private record(
    tx: Tx,
    auth: CompanyAuthContext,
    action: string,
    e: EntryRow,
    change: { from?: ReturnType<typeof content>; to?: ReturnType<typeof content> },
  ) {
    return this.audit.record(
      {
        action,
        companyId: auth.company.id,
        auth,
        entityType: 'TimesheetEntry',
        entityId: e.id,
        data: {
          workerId: e.assignment.workerId,
          date: isoDay(e.date),
          siteId: e.siteId,
          teamId: e.teamId,
          ...change,
        },
      },
      tx,
    );
  }
}

/** The month's period, created open on its first entry (daily or imported). */
export async function openPeriod(tx: Tx, companyId: string, year: number, month: number): Promise<string> {
  await tx.payrollPeriod.createMany({ data: [{ companyId, year, month }], skipDuplicates: true });
  const period = await tx.payrollPeriod.findUniqueOrThrow({ where: { companyId_year_month: { companyId, year, month } } });
  return period.id;
}

/** Hours of a month are entered only if that month's plan has the Timesheet module (AGENTS.md: Modules). */
async function assertTimesheetIn(tx: Tx, companyId: string, month: YearMonth) {
  if (!(await timesheetIn(tx, companyId, month))) throw conflict('timesheet.moduleOff', { ...month });
}
