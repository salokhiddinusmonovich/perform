import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma, type DayStatus } from '@prisma/client';
import { normalizeCode, parseCell, type CodeMap } from '@puantaj/payroll';
import {
  foldText,
  HOURS_IMPORT_REQUIRED,
  importMappingSchema,
  salarySchema,
  WORKER_IMPORT_REQUIRED,
  workerSchema,
  type CreateWorker,
  type ImportField,
  type ImportMapping,
  type ImportRequest,
  type YearMonth,
} from '@puantaj/schemas';
import { AuditService } from '../audit/audit.service';
import type { CompanyAuthContext } from '../auth/auth.context';
import { badRequest, conflict } from '../common/api-error';
import { dayToDate, inMonth, isoDay, monthSpan, previousDay } from '../common/dates';
import { SALARY_ORDER, WorkersService } from '../organisation/workers.service';
import { shiftPartsOf } from '../organisation/worker-shifts';
import { assertMonthsOpen, lockWorkerMonth, monthIndex } from '../pay-rules/months';
import { PrismaService } from '../prisma/prisma.service';
import { openPeriod } from '../timesheet/timesheet.service';
import {
  cellDate,
  cellText,
  columnsOf,
  guessEmploymentType,
  mappingFor,
  readWorkbook,
  type Cell,
  type Sheet,
} from './sheet';

/** The uploaded file (multer's in-memory file). */
export interface ImportFile {
  originalname: string;
  buffer: Buffer;
}

/**
 * Why a row (or, with row null, the whole file) can't be imported. `code` is translated
 * as `errors.<code>` (import.*, worker.*) or a validation key (validation.*). Cells with
 * the same problem in one row are listed together by their days.
 */
export interface ImportProblem {
  /** Excel row number; null: the file or sheet as a whole */
  row: number | null;
  employeeNumber: string | null;
  name: string | null;
  code: string;
  field?: ImportField;
  /** The file's value, as text */
  value?: string;
  days?: number[];
}

/** Where the file differs from a worker already in the app. The import changes nothing of theirs. */
export interface ImportWorkerChange {
  row: number;
  employeeNumber: string;
  name: string;
  field: 'site' | 'department' | 'leftOn' | 'salary';
  file: string | null;
  app: string | null;
}

export interface ImportPreview {
  fileName: string;
  sheetNames: string[];
  /** The sheet read; null: no sheet has day columns */
  sheet: string | null;
  headerRow: number | null;
  /** Header texts of the columns that aren't days, in column order */
  headers: string[];
  /** Day columns found (1…31) */
  days: number[];
  mapping: ImportMapping;
  /** The mapping is the one the company saved with its last import */
  mappingSaved: boolean;
  /** Values found in the file for each fixed choice, folded (foldText), so each can be mapped */
  values: { employmentType: string[] };
  locked: boolean;
  workers: {
    rows: number;
    new: number;
    existing: number;
    problems: ImportProblem[];
    /** What the import read differently from the file's own columns (e.g. an exit date from a code); never blocks it */
    notes: ImportProblem[];
    changes: ImportWorkerChange[];
  };
  hours: { workers: number; replaces: number; problems: ImportProblem[] };
  /** Earlier imports of the month, newest first */
  earlier: { id: string; fileName: string; workers: number; createdAt: Date; createdBy: { fullName: string } }[];
}

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;

/** A row of the sheet with the cells of the mapped fields. */
interface Row {
  row: number;
  employeeNumber: string | null;
  name: string | null;
  field: (f: ImportField) => Cell;
  day: (d: number) => Cell;
  /** Any day cell has a value */
  hasDays: boolean;
}

/** A day the hours step writes. NOT_EMPLOYED and OFF days aren't stored (as in the daily grid). */
interface PlannedDay {
  date: string;
  status: DayStatus;
  hours: string;
  assignmentId: string;
  siteId: string;
  teamId: string | null;
}

interface WorkerMonth {
  workerId: string;
  /** Every day's status or hours as the file has it, for the audit log */
  cells: Record<string, string>;
  entries: PlannedDay[];
}

/** How a day reads in the audit log: its hours ("7.5", as stored), or its status. */
const cellOf = (status: DayStatus, hours: string) => (status === 'WORKED' ? new Prisma.Decimal(hours).toString() : status);

/** Imports wait on large months; Prisma's default transaction timeout is 5 seconds. */
const TX_OPTIONS = { timeout: 180_000, maxWait: 30_000 };

/**
 * Excel import of a month's sheet (AGENTS.md: Excel import): the workers step adds the
 * workers new to the app, the hours step writes the daily grid. Every request reads the
 * whole file again; nothing is kept between preview and commit, and a commit checks
 * everything again inside its transaction.
 */
@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workers: WorkersService,
    private readonly audit: AuditService,
  ) {}

  async preview(auth: CompanyAuthContext, file: ImportFile, request: ImportRequest): Promise<ImportPreview> {
    const companyId = auth.company.id;
    const ym = { year: request.year, month: request.month };
    const read = await this.read(auth, file, request);
    const [locked, earlier] = await Promise.all([
      this.prisma.payrollPeriod.count({ where: { companyId, ...ym, status: 'LOCKED' } }),
      this.prisma.timesheetImport.findMany({
        where: { companyId, ...ym },
        orderBy: { createdAt: 'desc' },
        include: { createdBy: { select: { fullName: true } } },
      }),
    ]);
    const base = {
      fileName: read.fileName,
      sheetNames: read.sheetNames,
      mapping: read.mapping,
      mappingSaved: read.mappingSaved,
      locked: locked > 0,
      earlier: earlier.map((e) => ({
        id: e.id,
        fileName: e.fileName,
        workers: e.workers,
        createdAt: e.createdAt,
        createdBy: e.createdBy,
      })),
    };
    if (!read.sheet) {
      const problems = [fileProblem('import.noDaySheet')];
      return {
        ...base,
        sheet: null,
        headerRow: null,
        headers: [],
        days: [],
        values: { employmentType: [] },
        workers: { rows: 0, new: 0, existing: 0, problems, notes: [], changes: [] },
        hours: { workers: 0, replaces: 0, problems },
      };
    }
    const { sheet } = read;
    const workers = await this.checkWorkers(this.prisma, auth, ym, sheet, read.mapping);
    const hours = await this.checkHours(this.prisma, auth, ym, sheet, read.mapping);
    // Values not mapped yet are offered with their guess, for the user to confirm.
    const guessed = workers.employmentTypes.flatMap((v) => {
      const guess = guessEmploymentType(v);
      return guess ? [[v, guess] as const] : [];
    });
    return {
      ...base,
      mapping: {
        ...read.mapping,
        values: { employmentType: { ...Object.fromEntries(guessed), ...read.mapping.values.employmentType } },
      },
      sheet: sheet.name,
      headerRow: sheet.headerRow,
      headers: sheet.headers.map((h) => h.text),
      days: [...sheet.dayColumns.keys()].sort((a, b) => a - b),
      values: { employmentType: workers.employmentTypes },
      workers: {
        rows: workers.rows,
        new: workers.create.length,
        existing: workers.existing,
        problems: workers.problems,
        notes: workers.notes,
        changes: workers.changes,
      },
      hours: { workers: hours.months.length, replaces: hours.replaces, problems: hours.problems },
    };
  }

  /** Adds the file's new workers, all or none. Owners and admins. */
  async commitWorkers(auth: CompanyAuthContext, file: ImportFile, request: ImportRequest): Promise<{ created: number }> {
    const companyId = auth.company.id;
    const ym = { year: request.year, month: request.month };
    const read = await this.read(auth, file, request);
    if (!read.sheet) throw conflict('import.hasProblems', { problems: 1 });
    const sheet = read.sheet;
    return this.prisma.$transaction(async (tx) => {
      const checked = await this.checkWorkers(tx, auth, ym, sheet, read.mapping);
      if (checked.problems.length > 0) throw conflict('import.hasProblems', { problems: checked.problems.length });
      for (const plan of checked.create) {
        const { id } = await this.workers.createIn(tx, auth, plan.input);
        if (plan.leftOn) await this.workers.leaveIn(tx, auth, id, plan.leftOn);
        if (plan.salary) {
          await this.workers.addSalaryIn(tx, auth, id, { fromYear: ym.year, fromMonth: ym.month, monthlySalary: plan.salary, reason: null });
        }
      }
      await this.saveMapping(tx, auth, read.mapping);
      await this.audit.record(
        {
          action: 'workerImport.create',
          companyId,
          auth,
          entityType: 'Company',
          entityId: companyId,
          data: { ...ym, fileName: read.fileName, fileSha256: read.sha256, created: checked.create.length },
        },
        tx,
      );
      return { created: checked.create.length };
    }, TX_OPTIONS);
  }

  /**
   * Writes the month's hours from the file, all or none. A worker-month imported before is
   * replaced; one whose cells are all the same is left as it was. Owners, admins and
   * accountants.
   */
  async commitHours(
    auth: CompanyAuthContext,
    file: ImportFile,
    request: ImportRequest,
  ): Promise<{ importId: string; workers: number }> {
    const companyId = auth.company.id;
    const ym = { year: request.year, month: request.month };
    const read = await this.read(auth, file, request);
    if (!read.sheet) throw conflict('import.hasProblems', { problems: 1 });
    const sheet = read.sheet;
    const { first, last } = monthSpan(ym.year, ym.month);
    return this.prisma.$transaction(async (tx) => {
      await assertMonthsOpen(tx, companyId, ym);
      // Lock the file's worker-months (in one order, so two imports can't deadlock) before
      // checking: a daily entry or monthly totals written meanwhile can't slip in.
      const numbers = sheet.rows.flatMap((r) => {
        const text = read.columns.employeeNumber === undefined ? null : cellText(r.cells[read.columns.employeeNumber] ?? null);
        return text ? [text] : [];
      });
      const known = await tx.worker.findMany({ where: { companyId, employeeNumber: { in: numbers } }, select: { id: true } });
      for (const id of known.map((w) => w.id).sort()) await lockWorkerMonth(tx, id, ym.year, ym.month);

      const checked = await this.checkHours(tx, auth, ym, sheet, read.mapping);
      if (checked.problems.length > 0) throw conflict('import.hasProblems', { problems: checked.problems.length });

      const before = await tx.timesheetEntry.findMany({
        where: {
          companyId,
          importId: { not: null },
          date: { gte: first, lte: last },
          assignment: { workerId: { in: checked.months.map((m) => m.workerId) } },
        },
        include: { assignment: { select: { workerId: true } } },
      });
      const changed = checked.months.flatMap((m) => {
        const old = before.filter((e) => e.assignment.workerId === m.workerId);
        const same =
          old.length === m.entries.length &&
          m.entries.every((n) =>
            old.some(
              (o) =>
                isoDay(o.date) === n.date &&
                o.status === n.status &&
                o.hours.equals(n.hours) &&
                o.assignmentId === n.assignmentId &&
                o.siteId === n.siteId &&
                o.teamId === n.teamId,
            ),
          );
        return same ? [] : [{ month: m, old }];
      });

      const batch = await tx.timesheetImport.create({
        data: {
          companyId,
          ...ym,
          fileName: read.fileName,
          fileSha256: read.sha256,
          workers: changed.length,
          createdById: auth.user.id,
        },
      });
      const periodId = await openPeriod(tx, companyId, ym.year, ym.month);
      for (const { month: m, old } of changed) {
        if (old.length > 0) await tx.timesheetEntry.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
        await tx.timesheetEntry.createMany({
          data: m.entries.map((e) => ({
            companyId,
            periodId,
            assignmentId: e.assignmentId,
            siteId: e.siteId,
            teamId: e.teamId,
            date: dayToDate(e.date),
            status: e.status,
            hours: e.hours,
            importId: batch.id,
            createdById: auth.user.id,
            updatedById: auth.user.id,
          })),
        });
        await this.audit.record(
          {
            action: 'timesheetImport.worker',
            companyId,
            auth,
            entityType: 'Worker',
            entityId: m.workerId,
            data: {
              importId: batch.id,
              ...ym,
              from: old.length > 0 ? Object.fromEntries(old.map((o) => [isoDay(o.date), cellOf(o.status, o.hours.toString())])) : null,
              to: m.cells,
            },
          },
          tx,
        );
      }
      await this.saveMapping(tx, auth, read.mapping);
      await this.audit.record(
        {
          action: 'timesheetImport.create',
          companyId,
          auth,
          entityType: 'TimesheetImport',
          entityId: batch.id,
          data: { ...ym, fileName: read.fileName, fileSha256: read.sha256, workers: changed.length },
        },
        tx,
      );
      return { importId: batch.id, workers: changed.length };
    }, TX_OPTIONS);
  }

  /** Reads the file and the sheet to import, with the mapping to read it by. */
  private async read(auth: CompanyAuthContext, file: ImportFile, request: ImportRequest) {
    const { sheetNames, sheets } = await readWorkbook(file.buffer);
    const sheet = request.sheet ? sheets.find((s) => s.name === request.sheet) : sheets[0];
    if (request.sheet && !sheetNames.includes(request.sheet)) throw badRequest('import.sheetNotFound');
    const saved = request.mapping
      ? null
      : await this.prisma.importMapping.findUnique({ where: { companyId: auth.company.id } });
    const savedMapping = saved ? importMappingSchema.safeParse(saved.mapping) : null;
    const preferred = request.mapping ?? (savedMapping?.success ? savedMapping.data : null);
    const mapping = sheet ? mappingFor(sheet, preferred) : (preferred ?? { columns: {}, values: { employmentType: {} } });
    return {
      // Multer reads the name's UTF-8 bytes as Latin-1.
      fileName: Buffer.from(file.originalname, 'latin1').toString('utf8'),
      sha256: createHash('sha256').update(file.buffer).digest('hex'),
      sheetNames,
      sheet: sheet ?? null,
      mapping,
      mappingSaved: !request.mapping && Boolean(savedMapping?.success),
      columns: sheet ? columnsOf(sheet, mapping) : {},
    };
  }

  /** The rows of the sheet that hold a worker (rows without an employee number and a name are skipped). */
  private rows(sheet: Sheet, mapping: ImportMapping): Row[] {
    const columns = columnsOf(sheet, mapping);
    return sheet.rows.flatMap(({ row, cells }) => {
      const field = (f: ImportField): Cell => (columns[f] === undefined ? null : (cells[columns[f]] ?? null));
      const day = (d: number): Cell => {
        const col = sheet.dayColumns.get(d);
        return col === undefined ? null : (cells[col] ?? null);
      };
      const employeeNumber = cellText(field('employeeNumber'));
      const name = [cellText(field('lastName')), cellText(field('firstName'))].filter(Boolean).join(' ') || null;
      if (!employeeNumber && !name) return [];
      const hasDays = [...sheet.dayColumns.keys()].some((d) => cellText(day(d)) !== null);
      return [{ row, employeeNumber, name, field, day, hasDays }];
    });
  }

  /** Problems with the mapping itself: required columns not mapped, or a column mapped twice. */
  private mappingProblems(sheet: Sheet, mapping: ImportMapping, required: readonly ImportField[]): ImportProblem[] {
    const columns = columnsOf(sheet, mapping);
    const problems = required.filter((f) => columns[f] === undefined).map((f) => fileProblem('import.columnMissing', { field: f }));
    const seen = new Map<number, ImportField>();
    for (const [field, col] of Object.entries(columns) as [ImportField, number][]) {
      if (seen.has(col)) problems.push(fileProblem('import.columnTwice', { field }));
      seen.set(col, field);
    }
    return problems;
  }

  /** The rows of each employee number, and a problem for every row of a number that is there twice. */
  private numbered(rows: Row[], problems: ImportProblem[]): Row[] {
    const counts = new Map<string, number>();
    for (const r of rows) if (r.employeeNumber) counts.set(r.employeeNumber, (counts.get(r.employeeNumber) ?? 0) + 1);
    return rows.filter((r) => {
      if (!r.employeeNumber) {
        problems.push(rowProblem(r, 'import.noEmployeeNumber'));
        return false;
      }
      if (counts.get(r.employeeNumber)! > 1) {
        problems.push(rowProblem(r, 'import.duplicateEmployeeNumber', { value: r.employeeNumber }));
        return false;
      }
      return true;
    });
  }

  /** The workers step: which rows add a worker, and what keeps it from running. */
  private async checkWorkers(db: Db, auth: CompanyAuthContext, ym: YearMonth, sheet: Sheet, mapping: ImportMapping) {
    const companyId = auth.company.id;
    const required: ImportField[] = [...WORKER_IMPORT_REQUIRED, ...(auth.company.departments ? (['department'] as const) : [])];
    const problems = this.mappingProblems(sheet, mapping, required);
    const all = this.rows(sheet, mapping);
    const rows = this.numbered(all, problems);
    const create: { input: CreateWorker; leftOn: string | null; salary: string | null }[] = [];
    const changes: ImportWorkerChange[] = [];
    const notes: ImportProblem[] = [];

    const employmentTypes = [
      ...new Set(all.map((r) => cellText(r.field('employmentType'))).filter((v): v is string => v !== null).map(foldText)),
    ].sort();
    const typeOf = (folded: string) => mapping.values.employmentType[folded] ?? guessEmploymentType(folded);

    const [existing, sites, departments, pinfls, codeRows] = await Promise.all([
      db.worker.findMany({
        where: { companyId, employeeNumber: { in: rows.map((r) => r.employeeNumber!) } },
        include: {
          assignments: { orderBy: { hiredOn: 'desc' }, include: { site: true, department: true } },
          salaries: { orderBy: SALARY_ORDER },
        },
      }),
      db.site.findMany({ where: { companyId } }),
      db.department.findMany({ where: { companyId } }),
      db.worker.findMany({ where: { companyId, pinfl: { not: null } }, select: { pinfl: true, employeeNumber: true } }),
      db.timesheetCode.findMany({ where: { companyId } }),
    ]);
    const codes: CodeMap = new Map(codeRows.map((c) => [normalizeCode(c.code), c.status]));
    const filePinfls = new Map<string, number>();

    for (const r of rows) {
      const days = employmentInDays(r, sheet, codes, ym);
      const worker = existing.find((w) => w.employeeNumber === r.employeeNumber);
      if (worker) {
        const latest = worker.assignments[0];
        const fileLeftOn = cellDate(r.field('leftOn'));
        // No exit date in the file: the day before a "not employed" code after the worker started.
        const leftOn = fileLeftOn ?? (latest ? days.exitBefore(isoDay(latest.hiredOn))?.leftOn ?? null : null);
        changes.push(...this.changesOf(r, worker, ym, mapping, auth.company.departments, leftOn));
        continue;
      }
      const rowProblems: ImportProblem[] = [];
      const add = (code: string, extra: Partial<ImportProblem> = {}) => rowProblems.push(rowProblem(r, code, extra));
      const text = (f: ImportField) => cellText(r.field(f));
      const date = (f: ImportField) => {
        const value = cellDate(r.field(f));
        if (value === 'invalid') {
          add('import.invalidDate', { field: f, value: text(f) ?? '' });
          return null;
        }
        return value;
      };

      const typeText = text('employmentType');
      const employmentType = typeText === null ? null : typeOf(foldText(typeText));
      if (typeText !== null && !employmentType) add('import.valueNotMapped', { field: 'employmentType', value: typeText });
      const details = workerSchema.safeParse({
        employeeNumber: r.employeeNumber,
        lastName: text('lastName') ?? '',
        firstName: text('firstName') ?? '',
        patronymic: text('patronymic'),
        position: text('position'),
        employmentType: employmentType ?? undefined,
        pinfl: text('pinfl'),
        birthDate: date('birthDate'),
        nationality: text('nationality'),
        passportSeries: text('passportSeries'),
        passportNumber: text('passportNumber'),
        phone: text('phone') ?? undefined,
      });
      if (!details.success) {
        for (const issue of details.error.issues) {
          const field = issue.path[0] as ImportField;
          // An unmapped employment type is reported above.
          if (field === 'employmentType' && typeText !== null) continue;
          add(issue.message.startsWith('validation.') ? issue.message : 'validation.invalid', { field, value: text(field) ?? undefined });
        }
      } else if (details.data.pinfl) {
        const pinfl = details.data.pinfl;
        if (pinfls.some((p) => p.pinfl === pinfl)) add('worker.pinflTaken', { field: 'pinfl' });
        else if (filePinfls.has(pinfl)) add('import.duplicatePinfl', { field: 'pinfl' });
        filePinfls.set(pinfl, r.row);
      }

      const siteName = text('site');
      const site = siteName === null ? undefined : sites.find((s) => foldText(s.name) === foldText(siteName));
      if (siteName === null) add('validation.required', { field: 'site' });
      else if (!site) add('import.siteNotFound', { field: 'site', value: siteName });
      else if (!site.isActive) add('site.inactive', { field: 'site', value: siteName });

      let departmentId: string | null = null;
      if (auth.company.departments) {
        const name = text('department');
        const found = name === null ? [] : departments.filter((d) => foldText(d.name) === foldText(name));
        if (name === null) add('validation.required', { field: 'department' });
        else if (found.length === 0) add('import.departmentNotFound', { field: 'department', value: name });
        else if (found.length > 1) add('import.departmentAmbiguous', { field: 'department', value: name });
        else if (!found[0].isActive) add('department.inactive', { field: 'department', value: name });
        else departmentId = found[0].id;
      }

      let hiredOn = date('hiredOn');
      let leftOn = date('leftOn');
      if (hiredOn === null && cellDate(r.field('hiredOn')) === null) add('validation.required', { field: 'hiredOn' });
      if (hiredOn && leftOn && leftOn < hiredOn) {
        // The exit date is trusted (AGENTS.md: Excel import): placed from the first day worked in the month.
        if (days.firstValue && days.firstValue <= leftOn) {
          notes.push(rowProblem(r, 'import.hireAfterExit', { field: 'hiredOn', value: text('hiredOn')! }));
          hiredOn = days.firstValue;
        } else add('validation.leaveBeforeStart', { field: 'leftOn', value: text('leftOn')! });
      } else if (hiredOn && !leftOn) {
        const exit = days.exitBefore(hiredOn);
        if (exit && exit.leftOn < hiredOn) add('validation.leaveBeforeStart', { field: 'leftOn', value: exit.code });
        else if (exit) {
          notes.push(rowProblem(r, 'import.exitFromCode', { field: 'leftOn', value: exit.code, days: [exit.day] }));
          leftOn = exit.leftOn;
        }
      }

      const salaryText = text('salary');
      let salary: string | null = null;
      if (salaryText !== null && Number(salaryText) !== 0) {
        const parsed = salarySchema.shape.monthlySalary.safeParse(salaryText);
        if (parsed.success) salary = parsed.data;
        else add(parsed.error.issues[0].message, { field: 'salary', value: salaryText });
      }

      problems.push(...rowProblems);
      if (rowProblems.length === 0 && details.success && site && hiredOn) {
        create.push({
          input: { worker: details.data, placement: { siteId: site.id, teamId: null, departmentId, from: hiredOn } },
          leftOn,
          salary,
        });
      }
    }
    return { rows: all.length, existing: existing.length, create, problems, notes, changes, employmentTypes };
  }

  /** Where the file says something else than the app about a worker already in it. */
  private changesOf(
    r: Row,
    worker: Prisma.WorkerGetPayload<{
      include: { assignments: { include: { site: true; department: true } }; salaries: true };
    }>,
    ym: YearMonth,
    mapping: ImportMapping,
    departments: boolean,
    /** The exit date the file gives, from its column or a code; 'invalid' when it can't be read */
    fileLeftOn: string | null | 'invalid',
  ): ImportWorkerChange[] {
    const out: ImportWorkerChange[] = [];
    const base = { row: r.row, employeeNumber: r.employeeNumber!, name: r.name ?? r.employeeNumber! };
    const latest = worker.assignments[0] ?? null;
    const text = (f: ImportField) => cellText(r.field(f));
    const differs = (field: ImportWorkerChange['field'], file: string | null, app: string | null) => {
      if (file !== null && (app === null || foldText(file) !== foldText(app))) out.push({ ...base, field, file, app });
    };
    if (mapping.columns.site !== undefined) differs('site', text('site'), latest?.site.name ?? null);
    if (departments && mapping.columns.department !== undefined) {
      differs('department', text('department'), latest?.department?.name ?? null);
    }
    if (mapping.columns.leftOn !== undefined || fileLeftOn !== null) {
      const app = latest?.leftOn ? isoDay(latest.leftOn) : null;
      if (fileLeftOn !== 'invalid' && fileLeftOn !== app) out.push({ ...base, field: 'leftOn', file: fileLeftOn, app });
    }
    const salaryText = text('salary');
    if (salaryText !== null && Number(salaryText) !== 0) {
      const index = monthIndex(ym.year, ym.month);
      const inForce = worker.salaries.find((s) => monthIndex(s.fromYear, s.fromMonth) <= index);
      const parsed = salarySchema.shape.monthlySalary.safeParse(salaryText);
      if (parsed.success && !(inForce && inForce.monthlySalary.equals(parsed.data))) {
        out.push({ ...base, field: 'salary', file: parsed.data, app: inForce ? inForce.monthlySalary.toString() : null });
      }
    }
    return out;
  }

  /** The hours step: each worker-month the file writes, and what keeps it from running. */
  private async checkHours(db: Db, auth: CompanyAuthContext, ym: YearMonth, sheet: Sheet, mapping: ImportMapping) {
    const companyId = auth.company.id;
    const { first, last } = monthSpan(ym.year, ym.month);
    const daysInMonth = last.getUTCDate();
    const problems = this.mappingProblems(sheet, mapping, HOURS_IMPORT_REQUIRED);
    const missingDays = [...Array(daysInMonth).keys()].map((i) => i + 1).filter((d) => !sheet.dayColumns.has(d));
    if (missingDays.length > 0) problems.push(fileProblem('import.dayColumnsMissing', { days: missingDays }));
    const rows = this.numbered(this.rows(sheet, mapping), problems);

    const [codeRows, workers] = await Promise.all([
      db.timesheetCode.findMany({ where: { companyId } }),
      db.worker.findMany({
        where: { companyId, employeeNumber: { in: rows.map((r) => r.employeeNumber!) } },
        include: { assignments: { where: inMonth(ym.year, ym.month), orderBy: { hiredOn: 'asc' } } },
      }),
    ]);
    const codes: CodeMap = new Map(codeRows.map((c) => [normalizeCode(c.code), c.status]));
    const workerIds = workers.map((w) => w.id);
    const [totals, entries, shiftParts] = await Promise.all([
      db.monthlyHours.findMany({
        where: { companyId, ...ym, assignment: { workerId: { in: workerIds } } },
        distinct: ['assignmentId'],
        select: { assignment: { select: { workerId: true } } },
      }),
      db.timesheetEntry.findMany({
        where: { companyId, date: { gte: first, lte: last }, assignment: { workerId: { in: workerIds } } },
        select: { importId: true, assignment: { select: { workerId: true } } },
      }),
      mapping.columns.shift === undefined ? null : shiftPartsOf(db, companyId, workerIds, ym.year, ym.month),
    ]);

    const months: WorkerMonth[] = [];
    let replaces = 0;
    for (const r of rows) {
      const worker = workers.find((w) => w.employeeNumber === r.employeeNumber);
      if (!worker) {
        problems.push(rowProblem(r, 'import.workerNotFound', { value: r.employeeNumber! }));
        continue;
      }
      const placementOn = (date: string) =>
        worker.assignments.filter((p) => isoDay(p.hiredOn) <= date && (!p.leftOn || isoDay(p.leftOn) >= date)).at(-1) ?? null;
      // Not employed this month and nothing in the file: not part of this month.
      if (worker.assignments.length === 0 && !r.hasDays) continue;

      const cellProblems = new Map<string, ImportProblem>();
      const addCell = (code: string, day: number, value: string | undefined) => {
        const key = `${code}\u0000${value ?? ''}`;
        const found = cellProblems.get(key);
        if (found) found.days!.push(day);
        else cellProblems.set(key, rowProblem(r, code, { value, days: [day] }));
      };
      const month: WorkerMonth = { workerId: worker.id, cells: {}, entries: [] };
      for (let day = 1; day <= daysInMonth; day++) {
        if (!sheet.dayColumns.has(day)) continue;
        const date = isoDay(new Date(Date.UTC(ym.year, ym.month - 1, day)));
        const placement = placementOn(date);
        const raw = r.day(day);
        const value = cellText(raw) ?? undefined;
        // Dates and other non-text cells in a day column are never hours.
        const input = raw instanceof Date ? value : raw;
        const parsed = parseCell(input, codes, placement !== null);
        if (parsed) {
          if (parsed.status !== 'NOT_EMPLOYED') month.cells[date] = cellOf(parsed.status, parsed.hours);
          if (placement && parsed.status !== 'NOT_EMPLOYED' && parsed.status !== 'OFF') {
            month.entries.push({
              date,
              status: parsed.status,
              hours: parsed.hours,
              assignmentId: placement.id,
              siteId: placement.siteId,
              teamId: placement.teamId,
            });
          }
        } else if (value === undefined) addCell('import.blankWhileEmployed', day, undefined);
        else if (parseCell(input, codes, placement === null)) {
          addCell(placement ? 'import.notEmployedCodeWhileEmployed' : 'import.valueWhileNotEmployed', day, value);
        } else addCell('import.unknownCode', day, value);
      }
      const rowProblems = [...cellProblems.values()];

      if (shiftParts) {
        const fileShift = cellText(r.field('shift'));
        const parts = shiftParts.get(worker.id) ?? [];
        const employedDays = Object.keys(month.cells).filter((d) => placementOn(d));
        const appShifts = [
          ...new Set(employedDays.map((d) => parts.find((p) => p.from <= d && p.until >= d)?.shiftInfo?.name ?? null)),
        ];
        const matches =
          appShifts.length === 0 ||
          (appShifts.length === 1 && foldText(appShifts[0] ?? '') === foldText(fileShift ?? ''));
        if (!matches) {
          rowProblems.push(rowProblem(r, 'import.shiftMismatch', { field: 'shift', value: fileShift ?? '' }));
        }
      }

      const own = entries.filter((e) => e.assignment.workerId === worker.id);
      if (totals.some((t) => t.assignment.workerId === worker.id)) rowProblems.push(rowProblem(r, 'import.monthlyTotalsEntered'));
      if (own.some((e) => e.importId === null)) rowProblems.push(rowProblem(r, 'import.dailyEntriesEntered'));

      problems.push(...rowProblems);
      if (rowProblems.length === 0) {
        months.push(month);
        if (own.length > 0) replaces++;
      }
    }
    return { months, replaces, problems };
  }

  /** Saves the mapping as the company's, for the next import (audited when it changes). */
  private async saveMapping(tx: Tx, auth: CompanyAuthContext, mapping: ImportMapping) {
    const companyId = auth.company.id;
    const before = await tx.importMapping.findUnique({ where: { companyId } });
    if (before && JSON.stringify(before.mapping) === JSON.stringify(mapping)) return;
    const data = { mapping: mapping as unknown as Prisma.InputJsonObject, setById: auth.user.id, setAt: new Date() };
    await tx.importMapping.upsert({ where: { companyId }, create: { companyId, ...data }, update: data });
    await this.audit.record(
      {
        action: 'importMapping.set',
        companyId,
        auth,
        entityType: 'Company',
        entityId: companyId,
        data: { from: (before?.mapping ?? null) as Prisma.InputJsonValue, to: data.mapping },
      },
      tx,
    );
  }
}

/**
 * What a row's day cells say about employment in the month: the first day with hours or a
 * code other than a "not employed" one, and the exit a "not employed" code (e.g. CIKIS)
 * gives: the day before the first such code on or after the worker started.
 */
function employmentInDays(r: Row, sheet: Sheet, codes: CodeMap, ym: YearMonth) {
  const cells: { day: number; date: string; code: string; out: boolean }[] = [];
  const daysInMonth = monthSpan(ym.year, ym.month).last.getUTCDate();
  for (let day = 1; day <= daysInMonth; day++) {
    const text = sheet.dayColumns.has(day) ? cellText(r.day(day)) : null;
    if (text === null) continue;
    const date = isoDay(new Date(Date.UTC(ym.year, ym.month - 1, day)));
    cells.push({ day, date, code: text, out: codes.get(normalizeCode(text)) === 'NOT_EMPLOYED' });
  }
  return {
    firstValue: cells.find((c) => !c.out)?.date ?? null,
    exitBefore(started: string) {
      const first = cells.find((c) => c.out && c.date >= started);
      return first ? { day: first.day, code: first.code, leftOn: previousDay(first.date) } : null;
    },
  };
}

function fileProblem(code: string, extra: Partial<ImportProblem> = {}): ImportProblem {
  return { row: null, employeeNumber: null, name: null, code, ...extra };
}

function rowProblem(r: Row, code: string, extra: Partial<ImportProblem> = {}): ImportProblem {
  return { row: r.row, employeeNumber: r.employeeNumber, name: r.name, code, ...extra };
}
