import type { Role } from '@prisma/client';
import ExcelJS from 'exceljs';
import type TestAgent from 'supertest/lib/agent';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, createPlan, createUser, givePlan, loginAs, memberOfNewCompany, resetDb, startApp, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => (ctx = await startApp()));
afterAll(async () => ctx.app.close());
beforeEach(async () => resetDb(ctx.prisma));

// September 2026: Sept 1 is Independence Day and Sundays (6, 13, 20, 27) are rest days, so
// 25 working days; 9 hours on each of them pays exactly the salary.
const RULES = {
  restWeekdays: [7],
  normalHoursPerDay: '9',
  overtimeMultiplier: '1.5',
  restDayMultiplier: '2',
  holidayMultiplier: '2',
  absence: {
    LEAVE: { paid: true, hoursPerDay: null },
    SICK: { paid: true, hoursPerDay: '8' },
    TRAVEL: { paid: false, hoursPerDay: null },
  },
  travelPayMode: 'NONE',
  payRoundingStep: '1000',
};

const HEADERS = ['№', 'SICIL', 'SOYADI', 'ADI', 'Statu', 'Объект / Santiye', 'GIRIS TARIHI', 'CIKIS TARIHI', 'ÜCRET MAAŞ'];
const DAYS = 30;

interface Line {
  number: string | null;
  lastName: string;
  status?: string;
  site?: string;
  hired?: Date | string;
  left?: Date | string | null;
  salary?: number;
  /** One value per day of September; default: a full month (9 on working days, T otherwise) */
  days?: (string | number | null)[];
}

const isOff = (day: number) => day === 1 || new Date(Date.UTC(2026, 8, day)).getUTCDay() === 0;
const FULL: (string | number)[] = [...Array(DAYS).keys()].map((i) => (isOff(i + 1) ? 'T' : 9));

/** A sheet laid out like a customer's: a title row, then the header row with the days 1…30. */
async function workbook(lines: Line[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Notes').addRow(['nothing to import here']);
  const ws = wb.addWorksheet('Timesheet');
  ws.addRow(['Табель работников, сентябрь 2026']);
  ws.addRow([...HEADERS, ...[...Array(DAYS).keys()].map((i) => i + 1), 'TOPLAM']);
  lines.forEach((l, i) =>
    ws.addRow([
      i + 1,
      l.number,
      l.lastName,
      'Test',
      l.status ?? 'Direkt',
      l.site ?? 'Site A',
      l.hired ?? new Date(Date.UTC(2026, 6, 6)),
      l.left ?? null,
      l.salary ?? 7_500_000,
      ...(l.days ?? FULL),
      999,
    ]),
  );
  // A totals row at the bottom: no employee number and no name, so it is skipped.
  ws.addRow([null, null, null, null, null, null, null, null, null, ...Array(DAYS).fill(9)]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

type Agent = TestAgent;

function send(agent: Agent, path: string, file: Buffer, fields: Record<string, string> = {}) {
  let req = agent.post(`/api/imports/${path}`).field('year', '2026').field('month', '9');
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  return req.attach('file', file, 'Sentyabr – табель.xlsx');
}

async function company() {
  const owner = await memberOfNewCompany(ctx, 'OWNER');
  await owner.agent.put('/api/pay-rules/2026/9').send(RULES).expect(204);
  await owner.agent.post('/api/sites').send({ name: 'Site A' }).expect(201);
  await owner.agent
    .put('/api/timesheet-codes')
    .send({
      codes: [
        { code: 'IZ', status: 'LEAVE', inGrid: true },
        { code: 'T', status: 'OFF', inGrid: false },
        { code: '-', status: 'NOT_EMPLOYED', inGrid: false },
        { code: 'CIKIS', status: 'NOT_EMPLOYED', inGrid: false },
      ],
    })
    .expect(204);
  return owner;
}

async function member(companyId: string, role: Role) {
  const user = await createUser(ctx.prisma);
  await addMember(ctx.prisma, user.id, companyId, role);
  return { user, agent: await loginAs(ctx.app, user.email!) };
}

describe('Excel import', () => {
  it('guesses the columns, adds the new workers, then imports their hours, paid as an import', async () => {
    const owner = await company();
    const file = await workbook([
      { number: '10001', lastName: 'Aliyev' },
      { number: '10002', lastName: 'Karimov', status: 'Endirekt', salary: 0, left: '20.09.2026' },
    ]);

    const preview = (await send(owner.agent, 'preview', file).expect(200)).body;
    expect(preview).toMatchObject({
      fileName: 'Sentyabr – табель.xlsx',
      sheetNames: ['Notes', 'Timesheet'],
      sheet: 'Timesheet',
      headerRow: 2,
      mappingSaved: false,
      values: { employmentType: ['DIREKT', 'ENDIREKT'] },
      workers: { rows: 2, new: 2, existing: 0, problems: [] },
    });
    expect(preview.mapping.columns).toEqual({
      employeeNumber: 'SICIL',
      lastName: 'SOYADI',
      firstName: 'ADI',
      employmentType: 'Statu',
      site: 'Объект / Santiye',
      hiredOn: 'GIRIS TARIHI',
      leftOn: 'CIKIS TARIHI',
      salary: 'ÜCRET MAAŞ',
    });
    expect(preview.mapping.values.employmentType).toEqual({ DIREKT: 'DIRECT', ENDIREKT: 'INDIRECT' });
    expect(preview.days).toHaveLength(DAYS);
    // The workers aren't in the app yet, so their hours can't be imported.
    expect(preview.hours.problems.map((p: { code: string }) => p.code)).toEqual(['import.workerNotFound', 'import.workerNotFound']);
    expect(await ctx.prisma.worker.count()).toBe(0);

    const mapping = JSON.stringify(preview.mapping);
    await send(owner.agent, 'workers', file, { mapping }).expect(201, { created: 2 });
    const workers = await ctx.prisma.worker.findMany({
      orderBy: { employeeNumber: 'asc' },
      include: { assignments: true, salaries: true },
    });
    expect(workers.map((w) => [w.employeeNumber, w.lastName, w.employmentType])).toEqual([
      ['10001', 'Aliyev', 'DIRECT'],
      ['10002', 'Karimov', 'INDIRECT'],
    ]);
    expect(workers[0].assignments[0].hiredOn.toISOString().slice(0, 10)).toBe('2026-07-06');
    expect(workers[1].assignments[0].leftOn?.toISOString().slice(0, 10)).toBe('2026-09-20');
    expect(workers[0].salaries.map((s) => [s.fromYear, s.fromMonth, s.monthlySalary.toString()])).toEqual([[2026, 9, '7500000']]);
    expect(workers[1].salaries).toEqual([]);

    // The mapping is saved; the workers are now known, so the hours step has one problem left:
    // the worker who left on the 20th has hours after it.
    const again = (await send(owner.agent, 'preview', file).expect(200)).body;
    expect(again).toMatchObject({ mappingSaved: true, workers: { new: 0, existing: 2, problems: [] } });
    expect(again.hours.problems).toEqual([
      {
        row: 4,
        employeeNumber: '10002',
        name: 'Karimov Test',
        code: 'import.valueWhileNotEmployed',
        value: '9',
        days: [21, 22, 23, 24, 25, 26, 28, 29, 30],
      },
      expect.objectContaining({ row: 4, code: 'import.valueWhileNotEmployed', value: 'T', days: [27] }),
    ]);
    const refused = await send(owner.agent, 'hours', file).expect(409);
    expect(refused.body).toMatchObject({ code: 'import.hasProblems', problems: 2 });
    expect(await ctx.prisma.timesheetEntry.count()).toBe(0);

    const fixed = await workbook([
      { number: '10001', lastName: 'Aliyev' },
      { number: '10002', lastName: 'Karimov', status: 'Endirekt', salary: 0, left: '20.09.2026', days: FULL.map((v, i) => (i >= 20 ? '-' : v)) },
    ]);
    const done = (await send(owner.agent, 'hours', fixed).expect(201)).body;
    expect(done.workers).toBe(2);
    const entries = await ctx.prisma.timesheetEntry.findMany({ where: { assignment: { workerId: workers[0].id } } });
    // 25 working days with 9 hours; rest days and the holiday (T) aren't stored.
    expect(entries).toHaveLength(25);
    expect(entries.every((e) => e.importId === done.importId && e.status === 'WORKED')).toBe(true);

    const payroll = (await owner.agent.get('/api/payroll/2026/9').expect(200)).body;
    const aliyev = payroll.workers.find((w: { worker: { lastName: string } }) => w.worker.lastName === 'Aliyev');
    expect(aliyev).toMatchObject({ source: 'IMPORT', total: '7500000.00', problems: [] });

    const audit = await ctx.prisma.auditLog.findMany({ where: { action: { startsWith: 'timesheetImport.' } } });
    expect(audit.map((a) => a.action).sort()).toEqual(['timesheetImport.create', 'timesheetImport.worker', 'timesheetImport.worker']);
  });

  it('trusts an exit date before the hire date, and takes an exit date from a "not employed" code', async () => {
    const owner = await company();
    const cikisFrom = (day: number) => FULL.map((v, i) => (i + 1 >= day ? 'CIKIS' : v));
    const file = await workbook([
      // Left on 10 September; the hire date after it is ignored.
      { number: '1', lastName: 'Aliyev', hired: '20.09.2026', left: '10.09.2026', days: cikisFrom(11) },
      // No exit date: fired from the 25th.
      { number: '2', lastName: 'Karimov', days: cikisFrom(25) },
    ]);
    const preview = (await send(owner.agent, 'preview', file).expect(200)).body;
    expect(preview.workers).toMatchObject({ new: 2, problems: [] });
    expect(preview.workers.notes).toEqual([
      { row: 3, employeeNumber: '1', name: 'Aliyev Test', code: 'import.hireAfterExit', field: 'hiredOn', value: '20.09.2026' },
      { row: 4, employeeNumber: '2', name: 'Karimov Test', code: 'import.exitFromCode', field: 'leftOn', value: 'CIKIS', days: [25] },
    ]);
    await send(owner.agent, 'workers', file).expect(201, { created: 2 });
    const placements = await ctx.prisma.assignment.findMany({ include: { worker: true }, orderBy: { worker: { employeeNumber: 'asc' } } });
    expect(placements.map((p) => [p.worker.employeeNumber, p.hiredOn.toISOString().slice(0, 10), p.leftOn?.toISOString().slice(0, 10)])).toEqual([
      ['1', '2026-09-01', '2026-09-10'],
      ['2', '2026-07-06', '2026-09-24'],
    ]);
    // The CIKIS days are now outside the employment, so the hours fit.
    const again = (await send(owner.agent, 'preview', file).expect(200)).body;
    expect(again.workers.changes).toEqual([]);
    expect(again.hours).toMatchObject({ workers: 2, problems: [] });

    // Fired earlier in a later file: a difference to set on the worker's page.
    const earlier = await workbook([
      { number: '1', lastName: 'Aliyev', hired: '20.09.2026', left: '10.09.2026', days: cikisFrom(11) },
      { number: '2', lastName: 'Karimov', days: cikisFrom(20) },
    ]);
    const changes = (await send(owner.agent, 'preview', earlier).expect(200)).body.workers.changes;
    expect(changes).toEqual([
      { row: 4, employeeNumber: '2', name: 'Karimov Test', field: 'leftOn', file: '2026-09-19', app: '2026-09-24' },
    ]);
  });

  it('reads blank cells while employed as unexcused absences when the company chooses so', async () => {
    const owner = await company();
    // The month isn't finished: nothing from the 27th on.
    const partial = await workbook([{ number: '1', lastName: 'Aliyev', days: FULL.map((v, i) => (i + 1 >= 27 ? null : v)) }]);
    await send(owner.agent, 'workers', partial).expect(201);

    const strict = (await send(owner.agent, 'preview', partial).expect(200)).body;
    expect(strict.mapping.blankCells).toBe('PROBLEM');
    expect(strict.hours.problems.map((p: { code: string; days: number[] }) => [p.code, p.days])).toEqual([
      ['import.blankWhileEmployed', [27, 28, 29, 30]],
    ]);

    const mapping = JSON.stringify({ ...strict.mapping, blankCells: 'ABSENT' });
    const preview = (await send(owner.agent, 'preview', partial, { mapping }).expect(200)).body;
    expect(preview.hours).toMatchObject({ workers: 1, problems: [] });
    expect(preview.hours.notes).toEqual([
      { row: 3, employeeNumber: '1', name: 'Aliyev Test', code: 'import.blankAsAbsent', days: [27, 28, 29, 30] },
    ]);
    await send(owner.agent, 'hours', partial, { mapping }).expect(201);
    const absent = await ctx.prisma.timesheetEntry.findMany({ where: { status: 'ABSENT' }, orderBy: { date: 'asc' } });
    expect(absent.map((e) => e.date.toISOString().slice(0, 10))).toEqual(['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30']);
    // 22 of the 25 working days worked: 7 500 000 × 22 / 25.
    const payroll = (await owner.agent.get('/api/payroll/2026/9').expect(200)).body;
    expect(payroll.workers[0]).toMatchObject({ source: 'IMPORT', total: '6600000.00' });

    // The choice is saved with the mapping for the next import.
    expect((await send(owner.agent, 'preview', partial).expect(200)).body).toMatchObject({
      mappingSaved: true,
      mapping: { blankCells: 'ABSENT' },
    });
    // The complete file replaces the absences.
    expect((await send(owner.agent, 'hours', await workbook([{ number: '1', lastName: 'Aliyev' }])).expect(201)).body.workers).toBe(1);
    expect(await ctx.prisma.timesheetEntry.count({ where: { status: 'ABSENT' } })).toBe(0);
  });

  it('writes nothing while any row has a problem', async () => {
    const owner = await company();
    const file = await workbook([
      { number: '1', lastName: 'Aliyev' },
      { number: '2', lastName: 'Karimov', site: 'Nowhere' },
      { number: '2', lastName: 'Twice' },
      { number: null, lastName: 'NoNumber' },
      { number: '3', lastName: 'Odd', status: 'Contract', hired: 'soon' },
    ]);
    const preview = (await send(owner.agent, 'preview', file).expect(200)).body;
    const codes = preview.workers.problems.map((p: { row: number; code: string }) => `${p.row}:${p.code}`).sort();
    expect(codes).toEqual(
      ['4:import.duplicateEmployeeNumber', '5:import.duplicateEmployeeNumber', '6:import.noEmployeeNumber', '7:import.invalidDate', '7:import.valueNotMapped'].sort(),
    );
    const refused = await send(owner.agent, 'workers', file).expect(409);
    expect(refused.body.code).toBe('import.hasProblems');
    expect(await ctx.prisma.worker.count()).toBe(0);

    const unknownSite = await workbook([
      { number: '1', lastName: 'Aliyev' },
      { number: '2', lastName: 'Karimov', site: 'Nowhere' },
    ]);
    const second = (await send(owner.agent, 'preview', unknownSite).expect(200)).body;
    expect(second.workers.problems).toEqual([
      { row: 4, employeeNumber: '2', name: 'Karimov Test', code: 'import.siteNotFound', field: 'site', value: 'Nowhere' },
    ]);
    await send(owner.agent, 'workers', unknownSite).expect(409);
    expect(await ctx.prisma.worker.count()).toBe(0);
  });

  it('reports blank cells, unknown codes and a changed shift, and replaces an earlier import with an audit record', async () => {
    const owner = await company();
    await send(owner.agent, 'workers', await workbook([{ number: '1', lastName: 'Aliyev' }])).expect(201);
    const worker = await ctx.prisma.worker.findFirstOrThrow();

    const bad = await workbook([{ number: '1', lastName: 'Aliyev', days: FULL.map((v, i) => (i === 1 ? null : i === 2 ? 'ZZ' : v)) }]);
    const problems = (await send(owner.agent, 'preview', bad).expect(200)).body.hours.problems;
    expect(problems.map((p: { code: string; days: number[] }) => [p.code, p.days])).toEqual([
      ['import.blankWhileEmployed', [2]],
      ['import.unknownCode', [3]],
    ]);

    const first = await workbook([{ number: '1', lastName: 'Aliyev' }]);
    const one = (await send(owner.agent, 'hours', first).expect(201)).body;
    expect(one.workers).toBe(1);
    // The same file again changes nothing.
    expect((await send(owner.agent, 'hours', first).expect(201)).body.workers).toBe(0);

    const leave = await workbook([{ number: '1', lastName: 'Aliyev', days: FULL.map((v, i) => (i === 2 ? 'iz' : v)) }]);
    const preview = (await send(owner.agent, 'preview', leave).expect(200)).body;
    expect(preview.hours).toMatchObject({ workers: 1, replaces: 1, problems: [] });
    const two = (await send(owner.agent, 'hours', leave).expect(201)).body;
    const entries = await ctx.prisma.timesheetEntry.findMany({ orderBy: { date: 'asc' } });
    expect(entries).toHaveLength(25);
    expect(entries.every((e) => e.importId === two.importId)).toBe(true);
    expect(entries.find((e) => e.date.toISOString().startsWith('2026-09-03'))?.status).toBe('LEAVE');
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'timesheetImport.worker', data: { path: ['importId'], equals: two.importId } },
    });
    expect(audit.entityId).toBe(worker.id);
    expect(audit.data).toMatchObject({ from: { '2026-09-03': '9' }, to: { '2026-09-03': 'LEAVE', '2026-09-01': 'OFF' } });

    // A shift column must agree with the worker's shift in the app.
    const night = (await owner.agent.post('/api/shifts').send({ name: 'Gece', normalHoursPerDay: '10' }).expect(201)).body.id;
    await owner.agent.post('/api/worker-shifts').send({ shiftId: night, from: '2026-09-01', workerIds: [worker.id] }).expect(201);
    const withShift = async (shift: string) => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await workbook([{ number: '1', lastName: 'Aliyev' }])) as unknown as ArrayBuffer);
      const ws = wb.getWorksheet('Timesheet')!;
      ws.getCell(2, 50).value = 'Смена / Vardiya';
      ws.getCell(3, 50).value = shift;
      return Buffer.from(await wb.xlsx.writeBuffer());
    };
    // The saved mapping has no shift column: one the user left out stays out until they map it.
    const saved = (await send(owner.agent, 'preview', await withShift('Gunduz')).expect(200)).body;
    expect(saved.mappingSaved).toBe(true);
    expect(saved.headers).toContain('Смена / Vardiya');
    expect(saved.hours.problems).toEqual([]);
    const mapping = JSON.stringify({ ...saved.mapping, columns: { ...saved.mapping.columns, shift: 'Смена / Vardiya' } });
    expect((await send(owner.agent, 'preview', await withShift('GECE'), { mapping }).expect(200)).body.hours.problems).toEqual([]);
    const mismatch = (await send(owner.agent, 'preview', await withShift('Gunduz'), { mapping }).expect(200)).body.hours.problems;
    expect(mismatch).toEqual([expect.objectContaining({ code: 'import.shiftMismatch', field: 'shift', value: 'Gunduz' })]);
  });

  it('lets owners and admins edit imported days, keeps one source, and warns before an import overwrites them', async () => {
    const owner = await company();
    const companyId = owner.company.id;
    await givePlan(ctx.prisma, companyId, (await createPlan(ctx.prisma, { timesheetModule: true })).id, '2000-01-01');
    const siteId = (await ctx.prisma.site.findFirstOrThrow()).id;
    await send(owner.agent, 'workers', await workbook([{ number: '1', lastName: 'Aliyev' }])).expect(201);
    const file = await workbook([{ number: '1', lastName: 'Aliyev' }]);
    const { importId } = (await send(owner.agent, 'hours', file).expect(201)).body;
    const worker = await ctx.prisma.worker.findFirstOrThrow();
    const entryOn = (day: string) =>
      ctx.prisma.timesheetEntry.findFirstOrThrow({ where: { date: new Date(`${day}T00:00:00Z`) } });
    const body = (date: string, hours: string, version?: number) => ({
      workerId: worker.id,
      siteId,
      teamId: null,
      date,
      status: 'WORKED',
      hours,
      note: null,
      version,
    });
    const third = await entryOn('2026-09-03');
    const fourth = await entryOn('2026-09-04');

    // Everyone else corrects by importing again, and their grid is closed.
    const accountant = await member(companyId, 'ACCOUNTANT');
    await accountant.agent.put(`/api/timesheet/entries/${third.id}`).send(body('2026-09-03', '7', 1)).expect(403);
    const timekeeper = await member(companyId, 'TIMEKEEPER');
    await ctx.prisma.memberSite.create({ data: { userId: timekeeper.user.id, companyId, siteId } });
    const refused = await timekeeper.agent.put(`/api/timesheet/entries/${third.id}`).send(body('2026-09-03', '7', 1)).expect(409);
    expect(refused.body.code).toBe('timesheet.imported');
    await timekeeper.agent.delete(`/api/timesheet/entries/${third.id}?version=1`).expect(409);
    const seenByTimekeeper = (await timekeeper.agent.get(`/api/timesheet/2026/9?siteId=${siteId}`).expect(200)).body.rows[0];
    expect(seenByTimekeeper).toMatchObject({ hasImportedHours: true, canEnter: false });

    // The owner changes one day, clears another, and adds hours on a rest day.
    const changed = await owner.agent.put(`/api/timesheet/entries/${third.id}`).send(body('2026-09-03', '7', 1)).expect(200);
    expect(changed.body).toMatchObject({ hours: '7', imported: true });
    await owner.agent.delete(`/api/timesheet/entries/${fourth.id}?version=1`).expect(204);
    const added = crypto.randomUUID();
    await owner.agent.put(`/api/timesheet/entries/${added}`).send(body('2026-09-06', '5')).expect(200);
    expect((await ctx.prisma.timesheetEntry.findUniqueOrThrow({ where: { id: added } })).importId).toBe(importId);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'timesheetEntry.update', entityId: third.id } });
    expect(audit.data).toMatchObject({ from: { hours: '9' }, to: { hours: '7' } });

    const row = (await owner.agent.get(`/api/timesheet/2026/9?siteId=${siteId}`).expect(200)).body.rows[0];
    expect(row).toMatchObject({ hasImportedHours: true, canEnter: true, editedDays: ['2026-09-03', '2026-09-04', '2026-09-06'] });
    // Still one source on the payslip, with the edits shown.
    const pay = (await owner.agent.get('/api/payroll/2026/9').expect(200)).body.workers[0];
    expect(pay).toMatchObject({ source: 'IMPORT', editedDays: 3 });
    expect(pay.problems).toEqual([]);

    // The preview names the days the file would undo; one the file agrees with isn't listed.
    const agrees = await workbook([{ number: '1', lastName: 'Aliyev', days: FULL.map((v, i) => (i === 2 ? 7 : v)) }]);
    const preview = (await send(owner.agent, 'preview', agrees).expect(200)).body.hours;
    expect(preview).toMatchObject({ overwritesEdits: 2, problems: [] });
    expect(preview.notes).toEqual([expect.objectContaining({ code: 'import.overwritesEdits', days: [4, 6] })]);

    // The import has the last word and starts clean.
    await send(owner.agent, 'hours', file).expect(201);
    expect((await entryOn('2026-09-03')).hours.toString()).toBe('9');
    expect((await entryOn('2026-09-04')).hours.toString()).toBe('9');
    expect(await ctx.prisma.timesheetEntry.count({ where: { date: new Date('2026-09-06T00:00:00Z') } })).toBe(0);
    expect(await ctx.prisma.importedDayEdit.count()).toBe(0);
    expect((await send(owner.agent, 'preview', file).expect(200)).body.hours.overwritesEdits).toBe(0);
  });

  it('keeps edits of imported days apart between companies', async () => {
    const owner = await company();
    const companyId = owner.company.id;
    const siteId = (await ctx.prisma.site.findFirstOrThrow()).id;
    await send(owner.agent, 'workers', await workbook([{ number: '1', lastName: 'Aliyev' }])).expect(201);
    await send(owner.agent, 'hours', await workbook([{ number: '1', lastName: 'Aliyev' }])).expect(201);
    const worker = await ctx.prisma.worker.findFirstOrThrow();
    const entry = await ctx.prisma.timesheetEntry.findFirstOrThrow();

    const other = await memberOfNewCompany(ctx, 'OWNER');
    await givePlan(ctx.prisma, other.company.id, (await createPlan(ctx.prisma, { timesheetModule: true })).id, '2000-01-01');
    await other.agent.delete(`/api/timesheet/entries/${entry.id}?version=1`).expect(204);
    await other.agent
      .put(`/api/timesheet/entries/${entry.id}`)
      .send({ workerId: worker.id, siteId, teamId: null, date: '2026-09-02', status: 'WORKED', hours: '1', note: null, version: 1 })
      .expect(404);
    expect(await ctx.prisma.importedDayEdit.count({ where: { companyId } })).toBe(0);
    expect(await ctx.prisma.timesheetEntry.count({ where: { id: entry.id } })).toBe(1);
  });

  it('keeps one source per worker-month and refuses a locked month', async () => {
    const owner = await company();
    await send(owner.agent, 'workers', await workbook([{ number: '1', lastName: 'Aliyev' }])).expect(201);
    const placement = await ctx.prisma.assignment.findFirstOrThrow();
    await owner.agent
      .post(`/api/monthly-hours/2026/9/${placement.id}`)
      .send({
        from: '2026-09-01',
        until: '2026-09-30',
        normalHours: '225',
        overtimeHours: '0',
        restDayHours: '0',
        holidayHours: '0',
        workdaysWorked: 25,
        leaveDays: 0,
        sickDays: 0,
        travelDays: 0,
      })
      .expect(201);
    const file = await workbook([{ number: '1', lastName: 'Aliyev' }]);
    const problems = (await send(owner.agent, 'preview', file).expect(200)).body.hours.problems;
    expect(problems.map((p: { code: string }) => p.code)).toEqual(['import.monthlyTotalsEntered']);

    const other = await company();
    await send(other.agent, 'workers', file).expect(201);
    await ctx.prisma.payrollPeriod.create({
      data: { companyId: other.company.id, year: 2026, month: 9, status: 'LOCKED', lockedAt: new Date(), lockedById: other.user.id },
    });
    expect((await send(other.agent, 'preview', file).expect(200)).body.locked).toBe(true);
    expect((await send(other.agent, 'hours', file).expect(409)).body.code).toBe('period.locked');
    expect(await ctx.prisma.timesheetEntry.count()).toBe(0);
  });

  it('lets accountants import hours but not add workers, and nobody else import at all', async () => {
    const owner = await company();
    const file = await workbook([{ number: '1', lastName: 'Aliyev' }]);
    const accountant = await member(owner.company.id, 'ACCOUNTANT');
    await send(accountant.agent, 'preview', file).expect(200);
    await send(accountant.agent, 'workers', file).expect(403);
    await send(owner.agent, 'workers', file).expect(201);
    await send(accountant.agent, 'hours', file).expect(201);
    for (const role of ['PROJECT_MANAGER', 'TIMEKEEPER', 'FOREMAN'] as const) {
      const m = await member(owner.company.id, role);
      await send(m.agent, 'preview', file).expect(403);
      await send(m.agent, 'hours', file).expect(403);
    }
    const missing = await owner.agent.post('/api/imports/preview').field('year', '2026').field('month', '9').expect(400);
    expect(missing.body.code).toBe('import.noFile');
  });

  it("never matches or changes another company's workers", async () => {
    const a = await company();
    const b = await company();
    const file = await workbook([{ number: '1', lastName: 'Aliyev' }]);
    await send(b.agent, 'workers', file).expect(201);
    await send(b.agent, 'hours', file).expect(201);

    // Company A has no worker 1: B's worker is neither matched nor changed.
    const preview = (await send(a.agent, 'preview', file).expect(200)).body;
    expect(preview.workers).toMatchObject({ new: 1, existing: 0 });
    expect(preview.hours.problems.map((p: { code: string }) => p.code)).toEqual(['import.workerNotFound']);
    expect(preview.earlier).toEqual([]);
    await send(a.agent, 'workers', file).expect(201);
    await send(a.agent, 'hours', file).expect(201);
    const counts = await ctx.prisma.timesheetEntry.groupBy({ by: ['companyId'], _count: true });
    expect(counts.map((c) => c._count)).toEqual([25, 25]);
    expect(await ctx.prisma.worker.count({ where: { companyId: b.company.id } })).toBe(1);
  });
});
