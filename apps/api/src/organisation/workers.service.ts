import { Injectable } from '@nestjs/common';
import type { EmploymentType, FirmType, Prisma } from '@prisma/client';
import type { CreateWorker, Placement, Salary, Worker } from '@puantaj/schemas';
import { AuditService } from '../audit/audit.service';
import type { CompanyAuthContext } from '../auth/auth.context';
import { badRequest, conflict, notFound } from '../common/api-error';
import { dayToDate, isoDay, monthOfDay, previousDay, todayIn } from '../common/dates';
import { assertMonthsOpen, monthIndex } from '../pay-rules/months';
import { PrismaService } from '../prisma/prisma.service';
import { assertManagesSite, seesPay, seesPersonalData, seesPlacement } from './access';
import { findDepartment } from './departments.service';
import { findFirm } from './firms.service';
import { withinWorkerLimit } from './worker-limit';
import { shiftInfo, type ShiftInfo } from './worker-shifts';

export interface PlacementView {
  id: string;
  siteId: string;
  siteName: string;
  teamId: string | null;
  teamName: string | null;
  /** The placement's department (AGENTS.md: Departments); null: none set */
  departmentId: string | null;
  departmentName: string | null;
  /** The placement's employer (AGENTS.md: Firms); null: none set */
  firmId: string | null;
  firmName: string | null;
  firmType: FirmType | null;
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
  /** The firm it is paid by (AGENTS.md: Firms); null: from before the company used firms */
  firm: { id: string; name: string } | null;
  fromYear: number;
  fromMonth: number;
  monthlySalary: string;
  reason: string | null;
  /** A newer salary from the same month (and firm) corrected this one, so it never applies. */
  corrected: boolean;
  setBy: { fullName: string };
  setAt: Date;
}

export interface WorkerView {
  id: string;
  /** The company's own number for the worker; null: none given */
  employeeNumber: string | null;
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
   * The latest salary of the latest placement's firm (by from-month; it may start in a later month). null when there
   * is none yet or the caller doesn't see pay.
   */
  salary: Pick<SalaryView, 'fromYear' | 'fromMonth' | 'monthlySalary'> | null;
}

type Tx = Prisma.TransactionClient;

const PLACEMENT_INCLUDE = {
  site: { select: { name: true } },
  team: { select: { name: true } },
  department: { select: { name: true } },
  firm: { select: { name: true, type: true } },
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
  salaries: { orderBy: SALARY_ORDER },
  shifts: { orderBy: { fromDay: 'desc' }, include: { shift: true } },
} as const satisfies Prisma.WorkerInclude;

type WorkerRow = Prisma.WorkerGetPayload<{ include: typeof WORKER_INCLUDE }>;

/**
 * The salary that counts for a firm among a worker's salaries (newest first, SALARY_ORDER, up
 * to the month in question): the firm's own, else the newest without a firm (AGENTS.md:
 * Firms). A placement without a firm reads only those. While the company doesn't use firms
 * they don't matter, so the newest counts.
 */
export function salaryForFirm<S extends { firmId: string | null }>(
  rows: readonly S[],
  firmId: string | null,
  firmsOn: boolean,
): S | null {
  if (!firmsOn) return rows[0] ?? null;
  return rows.find((r) => r.firmId === firmId) ?? rows.find((r) => r.firmId === null) ?? null;
}

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
    return this.prisma.$transaction((tx) => this.createIn(tx, auth, input));
  }

  /** create() inside the caller's transaction (an Excel import adds many workers in one). */
  async createIn(tx: Tx, auth: CompanyAuthContext, input: CreateWorker): Promise<{ id: string }> {
    const companyId = auth.company.id;
    const { worker: details, placement } = input;
    assertManagesSite(auth, placement.siteId);
    const departmentId = await this.checkPlace(tx, auth, placement, 'placement.');
    const firmId = await this.checkFirm(tx, auth, placement, 'placement.');
    await this.assertUniqueFree(tx, companyId, details, null);
    await assertMonthsOpen(tx, companyId, monthOfDay(placement.from), null);
    const { worker, assignment } = await withinWorkerLimit(tx, companyId, null, placement.from, async () => {
      const worker = await tx.worker.create({ data: { companyId, ...toColumns(details) } });
      const assignment = await tx.assignment.create({ data: placementColumns(companyId, worker.id, placement, departmentId, firmId) });
      return { worker, assignment };
    });
    await this.record(tx, auth, 'worker.create', worker.id, {
      name: fullName(details),
      employeeNumber: details.employeeNumber,
      placement: { assignmentId: assignment.id, ...placement, departmentId, firmId },
      personalData: PERSONAL_FIELDS.filter((f) => details[f] !== null),
    });
    return { id: worker.id };
  }

  async update(auth: CompanyAuthContext, id: string, details: Worker): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const before = await this.find(tx, auth, id);
      assertManagesSite(auth, before.assignments[0].siteId);
      await this.assertUniqueFree(tx, companyId, details, id);
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
    await this.prisma.$transaction((tx) => this.placeIn(tx, auth, id, placement));
  }

  /** place() inside the caller's transaction. */
  async placeIn(tx: Tx, auth: CompanyAuthContext, id: string, placement: Placement): Promise<void> {
    const companyId = auth.company.id;
    const worker = await this.find(tx, auth, id);
    const current = worker.assignments[0];
    assertManagesSite(auth, current.siteId);
    assertManagesSite(auth, placement.siteId);
    const departmentId = await this.checkPlace(tx, auth, placement, '');
    const firmId = await this.checkFirm(tx, auth, placement, '');

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
      return tx.assignment.create({ data: placementColumns(companyId, id, placement, departmentId, firmId) });
    });
    await this.record(tx, auth, 'worker.place', id, {
      assignmentId: created.id,
      ...placement,
      departmentId,
      firmId,
      endedAssignmentId: stillThere ? current.id : null,
    });
  }

  /**
   * Fills in the department of a placement that has none (from before the company used
   * departments). A placement in a brigade takes the brigade's, set on the brigade. Pay
   * doesn't depend on it, so locked months don't stop it.
   */
  async fillDepartment(auth: CompanyAuthContext, id: string, placementId: string, departmentId: string): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const worker = await this.find(tx, auth, id);
      const placement = worker.assignments.find((p) => p.id === placementId);
      if (!placement) throw notFound('placement.notFound');
      assertManagesSite(auth, placement.siteId);
      if (placement.departmentId) throw conflict('placement.hasDepartment');
      if (placement.teamId) throw conflict('placement.departmentFromTeam');
      const department = await findDepartment(tx, companyId, departmentId);
      await tx.assignment.update({ where: { id: placementId }, data: { departmentId } });
      await this.record(tx, auth, 'worker.placementDepartment', id, {
        assignmentId: placementId,
        departmentId,
        departmentName: department.name,
      });
    });
  }

  /**
   * Fills in the firm of a placement that has none (from before the company used firms). The
   * firm decides the rules, salary and payslip of the placement's days, so none of its months
   * may be locked; a placement reaching into a locked month moves to the firm by a new
   * placement from a day instead.
   */
  async fillFirm(auth: CompanyAuthContext, id: string, placementId: string, firmId: string): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const worker = await this.find(tx, auth, id);
      const placement = worker.assignments.find((p) => p.id === placementId);
      if (!placement) throw notFound('placement.notFound');
      assertManagesSite(auth, placement.siteId);
      if (placement.firmId) throw conflict('placement.hasFirm');
      const firm = await findFirm(tx, companyId, firmId);
      const last = placement.leftOn && monthOfDay(isoDay(placement.leftOn));
      await assertMonthsOpen(
        tx,
        companyId,
        monthOfDay(isoDay(placement.hiredOn)),
        last && { year: last.year, month: last.month + 1 },
      );
      await tx.assignment.update({ where: { id: placementId }, data: { firmId } });
      await this.record(tx, auth, 'worker.placementFirm', id, {
        assignmentId: placementId,
        firmId,
        firmName: firm.name,
      });
    });
  }

  /** Sets the worker's last working day (or corrects it). */
  async leave(auth: CompanyAuthContext, id: string, date: string): Promise<void> {
    await this.prisma.$transaction((tx) => this.leaveIn(tx, auth, id, date));
  }

  /** leave() inside the caller's transaction. */
  async leaveIn(tx: Tx, auth: CompanyAuthContext, id: string, date: string): Promise<void> {
    const companyId = auth.company.id;
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
  }

  /** Every salary of the worker, newest first (SALARY_ORDER). */
  async salaries(auth: CompanyAuthContext, id: string): Promise<SalaryView[]> {
    await this.find(this.prisma, auth, id);
    const rows = await this.prisma.salary.findMany({
      where: { workerId: id, companyId: auth.company.id },
      orderBy: SALARY_ORDER,
      include: { setBy: { select: { fullName: true } }, firm: { select: { id: true, name: true } } },
    });
    return rows.map((r, i) => ({
      id: r.id,
      firm: r.firm,
      fromYear: r.fromYear,
      fromMonth: r.fromMonth,
      monthlySalary: r.monthlySalary.toString(),
      reason: r.reason,
      corrected: rows
        .slice(0, i)
        .some((o) => o.firmId === r.firmId && o.fromYear === r.fromYear && o.fromMonth === r.fromMonth),
      setBy: { fullName: r.setBy.fullName },
      setAt: r.setAt,
    }));
  }

  /**
   * Adds a salary from a month on. It covers the months until the next later salary, so
   * none of those may be locked. A salary from a month that already has one corrects it.
   * While the company uses firms all this is per firm, so a worker can have another salary
   * in a new firm for the same month (AGENTS.md: Firms).
   */
  async addSalary(auth: CompanyAuthContext, id: string, input: Salary): Promise<{ id: string }> {
    return this.prisma.$transaction((tx) => this.addSalaryIn(tx, auth, id, input));
  }

  /** addSalary() inside the caller's transaction. */
  async addSalaryIn(tx: Tx, auth: CompanyAuthContext, id: string, input: Salary): Promise<{ id: string }> {
    const companyId = auth.company.id;
    await this.find(tx, auth, id);
    const firmId = auth.company.firms ? input.firmId : null;
    if (auth.company.firms) {
      if (!firmId) throw badRequest('validation', { issues: [{ path: 'firmId', message: 'validation.required' }] });
      await findFirm(tx, companyId, firmId);
    }
    const start = monthIndex(input.fromYear, input.fromMonth);
    const rows = await tx.salary.findMany({
      where: { workerId: id, companyId, ...(auth.company.firms ? { firmId } : {}) },
      orderBy: SALARY_ORDER,
    });
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
      data: { companyId, workerId: id, ...input, firmId, setById: auth.user.id },
    });
    await this.record(tx, auth, 'salary.add', id, {
      salaryId: row.id,
      firmId,
      fromYear: input.fromYear,
      fromMonth: input.fromMonth,
      from: inForce ? inForce.monthlySalary.toString() : null,
      to: input.monthlySalary,
      reason: input.reason,
    });
    return { id: row.id };
  }

  /** Ends a placement on `lastDay`, unless timesheet days already exist after it. */
  private async endPlacement(tx: Tx, companyId: string, assignmentId: string, lastDay: string) {
    await assertMonthsOpen(tx, companyId, monthOfDay(lastDay), null);
    const later = await tx.timesheetEntry.count({ where: { assignmentId, date: { gt: dayToDate(lastDay) } } });
    if (later > 0) throw conflict('worker.hasLaterEntries');
    await tx.assignment.update({ where: { id: assignmentId }, data: { leftOn: dayToDate(lastDay) } });
  }

  /**
   * The site and team must be this company's, active, and the team on that site. Returns
   * the placement's department: the team's when there is a team, otherwise the one chosen,
   * which must be active. While the company uses departments, there must be one.
   * `at` is where the placement sits in the request body, so field errors name its fields
   * the way the form does ("placement.departmentId" when adding a worker).
   */
  private async checkPlace(
    tx: Tx,
    auth: CompanyAuthContext,
    placement: Placement,
    at: '' | 'placement.',
  ): Promise<string | null> {
    const companyId = auth.company.id;
    const invalid = (field: keyof Placement, message: string) =>
      badRequest('validation', { issues: [{ path: at + field, message }] });
    const site = await tx.site.findFirst({ where: { id: placement.siteId, companyId } });
    if (!site) throw notFound('site.notFound');
    if (!site.isActive) throw conflict('site.inactive');
    if (placement.teamId) {
      const team = await tx.team.findFirst({ where: { id: placement.teamId, companyId } });
      if (!team) throw notFound('team.notFound');
      if (team.siteId !== site.id) throw invalid('teamId', 'validation.teamNotOnSite');
      if (!team.isActive) throw conflict('team.inactive');
      if (placement.departmentId && placement.departmentId !== team.departmentId) {
        throw invalid('departmentId', 'validation.departmentNotTeams');
      }
      if (auth.company.departments && !team.departmentId) throw conflict('team.noDepartment');
      return team.departmentId;
    }
    if (placement.departmentId) return (await findDepartment(tx, companyId, placement.departmentId)).id;
    if (auth.company.departments) throw invalid('departmentId', 'validation.required');
    return null;
  }

  /**
   * The placement's firm: the one chosen, which must be active, and required while the company
   * uses firms. While it doesn't, placements have none.
   */
  private async checkFirm(tx: Tx, auth: CompanyAuthContext, placement: Placement, at: '' | 'placement.'): Promise<string | null> {
    if (!auth.company.firms) return null;
    if (!placement.firmId) {
      throw badRequest('validation', { issues: [{ path: `${at}firmId`, message: 'validation.required' }] });
    }
    return (await findFirm(tx, auth.company.id, placement.firmId)).id;
  }

  /** The PINFL and the employee number must not be another worker's in the company. */
  private async assertUniqueFree(tx: Tx, companyId: string, details: Worker, exceptId: string | null) {
    const not = exceptId ? { id: exceptId } : undefined;
    if (details.pinfl && (await tx.worker.findFirst({ where: { companyId, pinfl: details.pinfl, NOT: not } }))) {
      throw conflict('worker.pinflTaken');
    }
    const employeeNumber = details.employeeNumber;
    if (employeeNumber && (await tx.worker.findFirst({ where: { companyId, employeeNumber, NOT: not } }))) {
      throw conflict('worker.employeeNumberTaken');
    }
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
    const salary = salaryForFirm(w.salaries, p?.firmId ?? null, auth.company.firms);
    return {
      id: w.id,
      employeeNumber: w.employeeNumber,
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
            departmentId: p.departmentId,
            departmentName: p.department?.name ?? null,
            firmId: p.firmId,
            firmName: p.firm?.name ?? null,
            firmType: p.firm?.type ?? null,
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
        seesPay(auth) && salary
          ? {
              fromYear: salary.fromYear,
              fromMonth: salary.fromMonth,
              monthlySalary: salary.monthlySalary.toString(),
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
    employeeNumber: w.employeeNumber,
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

function placementColumns(companyId: string, workerId: string, p: Placement, departmentId: string | null, firmId: string | null) {
  return { companyId, workerId, siteId: p.siteId, teamId: p.teamId, departmentId, firmId, hiredOn: dayToDate(p.from) };
}

function shiftToday(auth: CompanyAuthContext, w: WorkerRow): ShiftInfo | null {
  const today = todayIn(auth.company.timezone);
  const row = w.shifts.find((s) => isoDay(s.fromDay) <= today);
  return row?.shift ? shiftInfo(row.shift) : null;
}
