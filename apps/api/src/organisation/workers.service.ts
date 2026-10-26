import { Injectable } from '@nestjs/common';
import type { EmploymentType, Prisma } from '@prisma/client';
import type { CreateWorker, Placement, Salary, Worker } from '@puantaj/schemas';
import { AuditService } from '../audit/audit.service';
import type { CompanyAuthContext } from '../auth/auth.context';
import { badRequest, conflict, notFound } from '../common/api-error';
import { dayToDate, isoDay, monthOfDay, previousDay, todayIn } from '../common/dates';
import { assertMonthsOpen, monthIndex } from '../pay-rules/months';
import { PrismaService } from '../prisma/prisma.service';
import { assertManagesSite, seesPay, seesPersonalData, seesPlacement } from './access';
import { withinWorkerLimit } from './worker-limit';
import { shiftInfo, type ShiftInfo } from './worker-shifts';

export interface PlacementView {
  id: string;
  siteId: string;
  siteName: string;
  teamId: string | null;
  teamName: string | null;
  /** First day at this site */
  from: string;
  /** Last day, or null while the worker is still there */
  until: string | null;
}

/** Never sent to timekeepers or foremen (AGENTS.md: Personal data). */
export interface PersonalDataView {
  pinfl: string | null;
  birthDate: string | null;
  nationality: string | null;
  passportSeries: string | null;
  passportNumber: string | null;
  phone: string | null;
}

/** A salary from a month on. Never sent to timekeepers or foremen (AGENTS.md: Roles). */
export interface SalaryView {
  id: string;
  fromYear: number;
  fromMonth: number;
  monthlySalary: string;
  reason: string | null;
  /** A newer salary from the same month corrected this one, so it never applies. */
  corrected: boolean;
  setBy: { fullName: string };
  setAt: Date;
}

export interface WorkerView {
  id: string;
  lastName: string;
  firstName: string;
  patronymic: string | null;
  position: string | null;
  employmentType: EmploymentType;
  /** The latest placement (the current one, or the last before leaving). */
  placement: PlacementView | null;
  /** The worker's shift today (AGENTS.md: Shifts); null: none, the rule set's normal hours */
  shift: ShiftInfo | null;
  /** null when the caller doesn't see personal data */
  personal: PersonalDataView | null;
  /**
   * The latest salary (by from-month; it may start in a later month). null when there
   * is none yet or the caller doesn't see pay.
   */
  salary: Pick<SalaryView, 'fromYear' | 'fromMonth' | 'monthlySalary'> | null;
}

type Tx = Prisma.TransactionClient;

const PLACEMENT_INCLUDE = {
  site: { select: { name: true } },
  team: { select: { name: true } },
} as const satisfies Prisma.AssignmentInclude;

/** Newest first: by from-month, then the one added last. The first row of a month is the one that counts. */
export const SALARY_ORDER = [
  { fromYear: 'desc' },
  { fromMonth: 'desc' },
  { seq: 'desc' },
] as const satisfies Prisma.SalaryOrderByWithRelationInput[];

/** Placements newest first: the first is the latest, which moves and leaving act on. */
const WORKER_INCLUDE = {
  assignments: { orderBy: { hiredOn: 'desc' }, include: PLACEMENT_INCLUDE },
  salaries: { orderBy: SALARY_ORDER, take: 1 },
  shifts: { orderBy: { fromDay: 'desc' }, include: { shift: true } },
} as const satisfies Prisma.WorkerInclude;

type WorkerRow = Prisma.WorkerGetPayload<{ include: typeof WORKER_INCLUDE }>;

const PERSONAL_FIELDS = ['pinfl', 'birthDate', 'nationality', 'passportSeries', 'passportNumber', 'phone'] as const;

/**
 * Workers and where they work. A worker has placements (Assignment): one site (and
 * maybe a team) from a first day to a last day. Moving to another site ends the current
 * placement the day before and starts a new one, so history stays as it was. Owners and
 * admins manage all workers; project managers those on their own sites.
 */
@Injectable()
export class WorkersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(auth: CompanyAuthContext): Promise<WorkerView[]> {
    const { id: companyId, siteIds, teamIds } = auth.company;
    // Narrow in the database, then keep the workers the caller sees (sees()).
    const scope: Prisma.WorkerWhereInput = siteIds
      ? { assignments: { some: { siteId: { in: siteIds } } } }
      : teamIds
        ? { assignments: { some: { teamId: { in: teamIds } } } }
        : {};
    const rows = await this.prisma.worker.findMany({
      where: { companyId, ...scope },
      include: WORKER_INCLUDE,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
    return rows.filter((w) => this.sees(auth, w)).map((w) => this.view(auth, w));
  }

  async get(auth: CompanyAuthContext, id: string): Promise<WorkerView> {
    return this.view(auth, await this.find(this.prisma, auth, id));
  }

  async create(auth: CompanyAuthContext, input: CreateWorker): Promise<{ id: string }> {
    const companyId = auth.company.id;
    const { worker: details, placement } = input;
    assertManagesSite(auth, placement.siteId);
    return this.prisma.$transaction(async (tx) => {
      await this.checkPlace(tx, companyId, placement);
      await this.assertPinflFree(tx, companyId, details.pinfl, null);
      await assertMonthsOpen(tx, companyId, monthOfDay(placement.from), null);
      const { worker, assignment } = await withinWorkerLimit(tx, companyId, null, placement.from, async () => {
        const worker = await tx.worker.create({ data: { companyId, ...toColumns(details) } });
        const assignment = await tx.assignment.create({ data: placementColumns(companyId, worker.id, placement) });
        return { worker, assignment };
      });
      await this.record(tx, auth, 'worker.create', worker.id, {
        name: fullName(details),
        placement: { assignmentId: assignment.id, ...placement },
        personalData: PERSONAL_FIELDS.filter((f) => details[f] !== null),
      });
      return { id: worker.id };
    });
  }

  async update(auth: CompanyAuthContext, id: string, details: Worker): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const before = await this.find(tx, auth, id);
      assertManagesSite(auth, before.assignments[0].siteId);
      await this.assertPinflFree(tx, companyId, details.pinfl, id);
      await tx.worker.update({ where: { id }, data: toColumns(details) });
      const old = toInput(before);
      const changed = (Object.keys(details) as (keyof Worker)[]).filter((k) => details[k] !== old[k]);
      await this.record(tx, auth, 'worker.update', id, {
        // Personal data is named, not copied, so the audit log doesn't become a second copy of it.
        changes: Object.fromEntries(
          changed.map((k) => [k, (PERSONAL_FIELDS as readonly string[]).includes(k) ? 'changed' : { from: old[k], to: details[k] }]),
        ),
      });
    });
  }

  /**
   * Starts a new placement from a day: a move to another site or team, or coming back
   * after leaving. A current placement ends the day before.
   */
  async place(auth: CompanyAuthContext, id: string, placement: Placement): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const worker = await this.find(tx, auth, id);
      const current = worker.assignments[0];
      assertManagesSite(auth, current.siteId);
      assertManagesSite(auth, placement.siteId);
      await this.checkPlace(tx, companyId, placement);

      const stillThere = current.leftOn === null || isoDay(current.leftOn) >= placement.from;
      const created = await withinWorkerLimit(tx, companyId, id, placement.from, async () => {
        if (stillThere) {
          if (placement.from <= isoDay(current.hiredOn)) {
            throw badRequest('validation', { issues: [{ path: 'from', message: 'validation.placementBeforeCurrent' }] });
          }
          const lastDay = previousDay(placement.from);
          await this.endPlacement(tx, companyId, current.id, lastDay);
        } else {
          await assertMonthsOpen(tx, companyId, monthOfDay(placement.from), null);
        }
        return tx.assignment.create({ data: placementColumns(companyId, id, placement) });
      });
      await this.record(tx, auth, 'worker.place', id, {
        assignmentId: created.id,
        ...placement,
        endedAssignmentId: stillThere ? current.id : null,
      });
    });
  }

  /** Sets the worker's last working day (or corrects it). */
  async leave(auth: CompanyAuthContext, id: string, date: string): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const worker = await this.find(tx, auth, id);
      const current = worker.assignments[0];
      assertManagesSite(auth, current.siteId);
      if (date < isoDay(current.hiredOn)) {
        throw badRequest('validation', { issues: [{ path: 'date', message: 'validation.leaveBeforeStart' }] });
      }
      // Moving the last day earlier or later changes the months from the earlier of the two.
      const from = current.leftOn && isoDay(current.leftOn) < date ? isoDay(current.leftOn) : date;
      await assertMonthsOpen(tx, companyId, monthOfDay(from), null);
      await this.endPlacement(tx, companyId, current.id, date);
      await this.record(tx, auth, 'worker.leave', id, {
        assignmentId: current.id,
        from: current.leftOn ? isoDay(current.leftOn) : null,
        to: date,
      });
    });
  }

  /** Every salary of the worker, newest first (SALARY_ORDER). */
  async salaries(auth: CompanyAuthContext, id: string): Promise<SalaryView[]> {
    await this.find(this.prisma, auth, id);
    const rows = await this.prisma.salary.findMany({
      where: { workerId: id, companyId: auth.company.id },
      orderBy: SALARY_ORDER,
      include: { setBy: { select: { fullName: true } } },
    });
    return rows.map((r, i) => ({
      id: r.id,
      fromYear: r.fromYear,
      fromMonth: r.fromMonth,
      monthlySalary: r.monthlySalary.toString(),
      reason: r.reason,
      corrected: i > 0 && rows[i - 1].fromYear === r.fromYear && rows[i - 1].fromMonth === r.fromMonth,
      setBy: { fullName: r.setBy.fullName },
      setAt: r.setAt,
    }));
  }

  /**
   * Adds a salary from a month on. It covers the months until the next later salary, so
   * none of those may be locked. A salary from a month that already has one corrects it.
   */
  async addSalary(auth: CompanyAuthContext, id: string, input: Salary): Promise<{ id: string }> {
    const companyId = auth.company.id;
    return this.prisma.$transaction(async (tx) => {
      await this.find(tx, auth, id);
      const start = monthIndex(input.fromYear, input.fromMonth);
      const rows = await tx.salary.findMany({ where: { workerId: id, companyId }, orderBy: SALARY_ORDER });
      const inForce = rows.find((r) => monthIndex(r.fromYear, r.fromMonth) <= start) ?? null;
      const next = rows.filter((r) => monthIndex(r.fromYear, r.fromMonth) > start).at(-1) ?? null;
      await assertMonthsOpen(
        tx,
        companyId,
        { year: input.fromYear, month: input.fromMonth },
        next && { year: next.fromYear, month: next.fromMonth },
      );
      if (inForce && inForce.monthlySalary.toString() === input.monthlySalary) throw conflict('salary.unchanged');

      const row = await tx.salary.create({
        data: { companyId, workerId: id, ...input, setById: auth.user.id },
      });
      await this.record(tx, auth, 'salary.add', id, {
        salaryId: row.id,
        fromYear: input.fromYear,
        fromMonth: input.fromMonth,
        from: inForce ? inForce.monthlySalary.toString() : null,
        to: input.monthlySalary,
        reason: input.reason,
      });
      return { id: row.id };
    });
  }

  /** Ends a placement on `lastDay`, unless timesheet days already exist after it. */
  private async endPlacement(tx: Tx, companyId: string, assignmentId: string, lastDay: string) {
    await assertMonthsOpen(tx, companyId, monthOfDay(lastDay), null);
    const later = await tx.timesheetEntry.count({ where: { assignmentId, date: { gt: dayToDate(lastDay) } } });
    if (later > 0) throw conflict('worker.hasLaterEntries');
    await tx.assignment.update({ where: { id: assignmentId }, data: { leftOn: dayToDate(lastDay) } });
  }

  /** The site and team must be this company's, active, and the team on that site. */
  private async checkPlace(tx: Tx, companyId: string, placement: Placement) {
    const site = await tx.site.findFirst({ where: { id: placement.siteId, companyId } });
    if (!site) throw notFound('site.notFound');
    if (!site.isActive) throw conflict('site.inactive');
    if (placement.teamId) {
      const team = await tx.team.findFirst({ where: { id: placement.teamId, companyId } });
      if (!team) throw notFound('team.notFound');
      if (team.siteId !== site.id) throw badRequest('validation', { issues: [{ path: 'teamId', message: 'validation.teamNotOnSite' }] });
      if (!team.isActive) throw conflict('team.inactive');
    }
  }

  private async assertPinflFree(tx: Tx, companyId: string, pinfl: string | null, exceptId: string | null) {
    if (!pinfl) return;
    const other = await tx.worker.findFirst({ where: { companyId, pinfl, NOT: exceptId ? { id: exceptId } : undefined } });
    if (other) throw conflict('worker.pinflTaken');
  }

  /** A worker the caller sees, or 404 (another company's or out of scope look the same). */
  async find(db: Tx | PrismaService, auth: CompanyAuthContext, id: string): Promise<WorkerRow> {
    const worker = await db.worker.findFirst({ where: { id, companyId: auth.company.id }, include: WORKER_INCLUDE });
    if (!worker || !this.sees(auth, worker)) throw notFound('worker.notFound');
    return worker;
  }

  /**
   * The caller sees a worker through the latest placement or any placement not ended
   * before today. So a move planned for a later day doesn't hide the worker from the
   * site or team they still work in; after leaving, the last placement decides.
   */
  private sees(auth: CompanyAuthContext, worker: WorkerRow): boolean {
    const today = todayIn(auth.company.timezone);
    return worker.assignments.some(
      (p, i) =>
        (i === 0 || p.leftOn === null || isoDay(p.leftOn) >= today) && seesPlacement(auth, p.siteId, p.teamId),
    );
  }

  private view(auth: CompanyAuthContext, w: WorkerRow): WorkerView {
    const p = w.assignments[0];
    return {
      id: w.id,
      lastName: w.lastName,
      firstName: w.firstName,
      patronymic: w.patronymic,
      position: w.position,
      employmentType: w.employmentType,
      placement: p
        ? {
            id: p.id,
            siteId: p.siteId,
            siteName: p.site.name,
            teamId: p.teamId,
            teamName: p.team?.name ?? null,
            from: isoDay(p.hiredOn),
            until: p.leftOn ? isoDay(p.leftOn) : null,
          }
        : null,
      shift: shiftToday(auth, w),
      personal: seesPersonalData(auth)
        ? {
            pinfl: w.pinfl,
            birthDate: w.birthDate ? isoDay(w.birthDate) : null,
            nationality: w.nationality,
            passportSeries: w.passportSeries,
            passportNumber: w.passportNumber,
            phone: w.phone,
          }
        : null,
      salary:
        seesPay(auth) && w.salaries[0]
          ? {
              fromYear: w.salaries[0].fromYear,
              fromMonth: w.salaries[0].fromMonth,
              monthlySalary: w.salaries[0].monthlySalary.toString(),
            }
          : null,
    };
  }

  private record(tx: Tx, auth: CompanyAuthContext, action: string, workerId: string, data: Prisma.InputJsonObject) {
    return this.audit.record(
      { action, companyId: auth.company.id, auth, entityType: 'Worker', entityId: workerId, data },
      tx,
    );
  }
}

const fullName = (w: Pick<Worker, 'lastName' | 'firstName' | 'patronymic'>) =>
  [w.lastName, w.firstName, w.patronymic].filter(Boolean).join(' ');

function toColumns(w: Worker) {
  return { ...w, birthDate: w.birthDate ? dayToDate(w.birthDate) : null };
}

function toInput(w: WorkerRow): Worker {
  return {
    lastName: w.lastName,
    firstName: w.firstName,
    patronymic: w.patronymic,
    position: w.position,
    employmentType: w.employmentType,
    pinfl: w.pinfl,
    birthDate: w.birthDate ? isoDay(w.birthDate) : null,
    nationality: w.nationality,
    passportSeries: w.passportSeries,
    passportNumber: w.passportNumber,
    phone: w.phone,
  };
}

function placementColumns(companyId: string, workerId: string, p: Placement) {
  return { companyId, workerId, siteId: p.siteId, teamId: p.teamId, hiredOn: dayToDate(p.from) };
}

function shiftToday(auth: CompanyAuthContext, w: WorkerRow): ShiftInfo | null {
  const today = todayIn(auth.company.timezone);
  const row = w.shifts.find((s) => isoDay(s.fromDay) <= today);
  return row?.shift ? shiftInfo(row.shift) : null;
}
