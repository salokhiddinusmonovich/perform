import type { Role } from '@prisma/client';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, createUser, loginAs, memberOfNewCompany, resetDb, startApp, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => (ctx = await startApp()));
afterAll(async () => ctx.app.close());
beforeEach(async () => resetDb(ctx.prisma));

type Agent = Awaited<ReturnType<typeof memberOfNewCompany>>['agent'];

// September 2026: Sept 1 is a holiday and Sundays are rest days, so 25 working days: 12 up to
// the 15th and 13 from the 16th.
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
};

const totals = (from: string, until: string, normalHours: string, workdaysWorked: number) => ({
  from,
  until,
  normalHours,
  overtimeHours: '0',
  restDayHours: '0',
  holidayHours: '0',
  workdaysWorked,
  leaveDays: 0,
  sickDays: 0,
  travelDays: 0,
});
const FIRST_HALF = totals('2026-09-01', '2026-09-30', '108', 12);
const SECOND_HALF = totals('2026-09-01', '2026-09-30', '117', 13);

/** A company with rules for September, a site, and two firms; firms on unless asked otherwise. */
async function company({ on = true }: { on?: boolean } = {}) {
  const owner = await memberOfNewCompany(ctx, 'OWNER');
  await owner.agent.put('/api/pay-rules/2026/9').send({ ...RULES, payRoundingStep: '1000' }).expect(204);
  const site = (await owner.agent.post('/api/sites').send({ name: 'Site A' }).expect(201)).body.id as string;
  const own = await firm(owner.agent, 'Perform MEP', 'OWN');
  const sub = await firm(owner.agent, 'Subcontractor X', 'SUBCONTRACTOR');
  if (on) await owner.agent.put('/api/firms/settings').send({ enabled: true }).expect(204);
  return { ...owner, site, own, sub };
}

async function firm(agent: Agent, name: string, type: string) {
  return (await agent.post('/api/firms').send({ name, type }).expect(201)).body.id as string;
}

async function member(companyId: string, role: Role) {
  const user = await createUser(ctx.prisma);
  await addMember(ctx.prisma, user.id, companyId, role);
  return { user, agent: await loginAs(ctx.app, user.email!) };
}

const hire = (agent: Agent, placement: { siteId: string; firmId?: string | null; from?: string }) =>
  agent
    .post('/api/workers')
    .send({ worker: { lastName: 'Testov', firstName: 'Test', employmentType: 'DIRECT' }, placement: { from: '2026-09-01', ...placement } });

const salary = (agent: Agent, workerId: string, firmId: string | null, monthlySalary: string) =>
  agent.post(`/api/workers/${workerId}/salaries`).send({ firmId, fromYear: 2026, fromMonth: 9, monthlySalary });

/** A worker in one firm up to the 15th and in another from the 16th, each with its own salary and hours. */
async function movedWorker(c: Awaited<ReturnType<typeof company>>) {
  const workerId = (await hire(c.agent, { siteId: c.site, firmId: c.own }).expect(201)).body.id as string;
  await c.agent.post(`/api/workers/${workerId}/placements`).send({ siteId: c.site, firmId: c.sub, from: '2026-09-16' }).expect(204);
  await salary(c.agent, workerId, c.own, '7500000').expect(201);
  await salary(c.agent, workerId, c.sub, '10000000').expect(201);
  const placements = await ctx.prisma.assignment.findMany({ where: { workerId }, orderBy: { hiredOn: 'asc' } });
  await c.agent.post(`/api/monthly-hours/2026/9/${placements[0].id}`).send(FIRST_HALF).expect(201);
  await c.agent.post(`/api/monthly-hours/2026/9/${placements[1].id}`).send(SECOND_HALF).expect(201);
  return { workerId, placements };
}

describe('firms', () => {
  it('lets owners and admins manage them; everyone sees them; audited', async () => {
    const { company: c, agent, own, sub } = await company({ on: false });
    const foreman = await member(c.id, 'FOREMAN');
    const accountant = await member(c.id, 'ACCOUNTANT');
    await accountant.agent.post('/api/firms').send({ name: 'Other', type: 'OWN' }).expect(403);
    await accountant.agent.patch(`/api/firms/${own}`).send({ name: 'New' }).expect(403);
    await accountant.agent.put('/api/firms/settings').send({ enabled: true }).expect(403);

    expect((await foreman.agent.get('/api/firms').expect(200)).body).toEqual([
      { id: own, name: 'Perform MEP', type: 'OWN', isActive: true },
      { id: sub, name: 'Subcontractor X', type: 'SUBCONTRACTOR', isActive: true },
    ]);
    expect((await agent.post('/api/firms').send({ name: 'perform mep', type: 'OWN' }).expect(409)).body.code).toBe('firm.nameTaken');
    await agent.patch(`/api/firms/${sub}`).send({ name: 'Sub Y', type: 'OWN' }).expect(204);
    const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { companyId: c.id, action: 'firm.update' } });
    expect(log.data).toEqual({ changes: { name: { from: 'Subcontractor X', to: 'Sub Y' }, type: { from: 'SUBCONTRACTOR', to: 'OWN' } } });
  });

  it("keeps another company's firms apart", async () => {
    const a = await company();
    const b = await company();
    const worker = (await hire(b.agent, { siteId: b.site, firmId: b.own }).expect(201)).body.id as string;

    expect((await a.agent.get('/api/firms').expect(200)).body.map((f: { id: string }) => f.id)).not.toContain(b.own);
    await a.agent.patch(`/api/firms/${b.own}`).send({ name: 'Stolen' }).expect(404);
    await hire(a.agent, { siteId: a.site, firmId: b.own }).expect(404);
    await salary(b.agent, worker, a.own, '5000000').expect(404);
    await a.agent.get(`/api/firms/${b.own}/pay-rules`).expect(404);
    await a.agent.put(`/api/firms/${b.own}/pay-rules/2026/9`).send(RULES).expect(404);
    await a.agent.get(`/api/firms/${b.own}/working-days?year=2026`).expect(404);
    await expect(
      ctx.prisma.assignment.updateMany({ where: { workerId: worker }, data: { firmId: a.own } }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('needs an active firm to be switched on, and refuses closing one with workers', async () => {
    const owner = await memberOfNewCompany(ctx, 'OWNER');
    const refused = await owner.agent.put('/api/firms/settings').send({ enabled: true }).expect(409);
    expect(refused.body.code).toBe('firm.noneActive');

    const c = await company();
    const worker = (await hire(c.agent, { siteId: c.site, firmId: c.own }).expect(201)).body.id as string;
    expect((await c.agent.patch(`/api/firms/${c.own}`).send({ isActive: false }).expect(409)).body.code).toBe('firm.hasWorkers');
    await c.agent.patch(`/api/firms/${c.sub}`).send({ isActive: false }).expect(204);
    expect((await hire(c.agent, { siteId: c.site, firmId: c.sub }).expect(409)).body.code).toBe('firm.inactive');
    await c.agent.post(`/api/workers/${worker}/leave`).send({ date: '2026-09-02' }).expect(204);
    await c.agent.patch(`/api/firms/${c.own}`).send({ isActive: false }).expect(204);
  });

  it('needs a firm on new placements only while switched on, and shows it on the worker', async () => {
    const off = await company({ on: false });
    const plain = (await hire(off.agent, { siteId: off.site, firmId: off.own }).expect(201)).body.id as string;
    // Off: firms are hidden, so nothing is stored.
    expect((await off.agent.get(`/api/workers/${plain}`).expect(200)).body.placement.firmId).toBeNull();

    const on = await company();
    const refused = await hire(on.agent, { siteId: on.site }).expect(400);
    expect(refused.body.issues).toEqual([{ path: 'placement.firmId', message: 'validation.required' }]);
    const worker = (await hire(on.agent, { siteId: on.site, firmId: on.sub }).expect(201)).body.id as string;
    expect((await on.agent.get(`/api/workers/${worker}`).expect(200)).body.placement).toMatchObject({
      firmId: on.sub,
      firmName: 'Subcontractor X',
      firmType: 'SUBCONTRACTOR',
    });
  });

  it('fills in the firm of an older placement, unless one of its months is locked', async () => {
    const c = await company({ on: false });
    const worker = (await hire(c.agent, { siteId: c.site }).expect(201)).body.id as string;
    const placement = (await ctx.prisma.assignment.findFirstOrThrow({ where: { workerId: worker } })).id;
    await c.agent.put('/api/firms/settings').send({ enabled: true }).expect(204);

    await ctx.prisma.payrollPeriod.create({
      data: { companyId: c.company.id, year: 2026, month: 9, status: 'LOCKED', lockedAt: new Date(), lockedById: c.user.id },
    });
    const locked = await c.agent.put(`/api/workers/${worker}/placements/${placement}/firm`).send({ firmId: c.own }).expect(409);
    expect(locked.body.code).toBe('period.locked');
    await ctx.prisma.payrollPeriod.updateMany({ data: { status: 'OPEN', lockedAt: null, lockedById: null } });

    await c.agent.put(`/api/workers/${worker}/placements/${placement}/firm`).send({ firmId: c.own }).expect(204);
    const again = await c.agent.put(`/api/workers/${worker}/placements/${placement}/firm`).send({ firmId: c.sub }).expect(409);
    expect(again.body.code).toBe('placement.hasFirm');
  });
});

describe('salaries per firm', () => {
  it('keeps one salary per firm and month, and needs a firm while switched on', async () => {
    const c = await company();
    const worker = (await hire(c.agent, { siteId: c.site, firmId: c.own }).expect(201)).body.id as string;
    expect((await salary(c.agent, worker, null, '5000000').expect(400)).body.issues).toEqual([
      { path: 'firmId', message: 'validation.required' },
    ]);
    await salary(c.agent, worker, c.own, '5000000').expect(201);
    // The same amount in another firm is a salary of its own, not "unchanged".
    await salary(c.agent, worker, c.sub, '5000000').expect(201);
    expect((await salary(c.agent, worker, c.own, '5000000').expect(409)).body.code).toBe('salary.unchanged');
    await salary(c.agent, worker, c.own, '6000000').expect(201);

    const rows = (await c.agent.get(`/api/workers/${worker}/salaries`).expect(200)).body;
    expect(rows.map((r: { firm: { name: string }; monthlySalary: string; corrected: boolean }) => [r.firm.name, r.monthlySalary, r.corrected])).toEqual([
      ['Perform MEP', '6000000', false],
      ['Subcontractor X', '5000000', false],
      ['Perform MEP', '5000000', true],
    ]);
  });

  it('never carries a salary to a new firm, but one from before firms counts until the firm has its own', async () => {
    const c = await company({ on: false });
    const worker = (await hire(c.agent, { siteId: c.site }).expect(201)).body.id as string;
    await salary(c.agent, worker, null, '7500000').expect(201);
    const placement = (await ctx.prisma.assignment.findFirstOrThrow({ where: { workerId: worker } })).id;
    await c.agent.post(`/api/monthly-hours/2026/9/${placement}`).send(totals('2026-09-01', '2026-09-30', '225', 25)).expect(201);
    await c.agent.put('/api/firms/settings').send({ enabled: true }).expect(204);
    await c.agent.put(`/api/workers/${worker}/placements/${placement}/firm`).send({ firmId: c.own }).expect(204);

    let view = (await c.agent.get('/api/payroll/2026/9').expect(200)).body.workers[0];
    expect(view.total).toBe('7500000.00');

    await salary(c.agent, worker, c.own, '9000000').expect(201);
    view = (await c.agent.get('/api/payroll/2026/9').expect(200)).body.workers[0];
    expect(view.total).toBe('9000000.00');

    // A firm's salary doesn't reach another firm: without the old salary, the new firm has none.
    await ctx.prisma.salary.deleteMany({ where: { workerId: worker, firmId: null } });
    await c.agent.post(`/api/workers/${worker}/placements`).send({ siteId: c.site, firmId: c.sub, from: '2026-09-16' }).expect(204);
    view = (await c.agent.get('/api/payroll/2026/9').expect(200)).body.workers[0];
    expect(view.problems).toContainEqual({ code: 'noSalary', firmName: 'Subcontractor X' });
  });
});

describe('payroll per firm', () => {
  it('pays each firm its own payslip at its own salary, rounded on its own', async () => {
    const c = await company();
    await movedWorker(c);

    const month = (await c.agent.get('/api/payroll/2026/9').expect(200)).body;
    const view = month.workers[0];
    expect(view.problems).toEqual([]);
    expect(view.payOut).toBeNull();
    expect(view.payslips.map((p: { firm: { name: string }; salary: { monthlySalary: string }; total: string }) => [p.firm.name, p.salary.monthlySalary, p.total])).toEqual([
      ['Perform MEP', '7500000', '3600000.00'],
      ['Subcontractor X', '10000000', '5200000.00'],
    ]);
    expect(view.total).toBe('8800000.00');
    expect(month.total).toBe('8800000.00');
    expect(view.parts.map((p: { firm: { name: string } }) => p.firm.name)).toEqual(['Perform MEP', 'Subcontractor X']);
    expect(view.firms.map((f: { name: string }) => f.name)).toEqual(['Perform MEP', 'Subcontractor X']);
    expect(month.firms.map((f: { firm: { name: string; type: string }; workers: number; total: string }) => [f.firm.name, f.firm.type, f.workers, f.total])).toEqual([
      ['Perform MEP', 'OWN', 1, '3600000.00'],
      ['Subcontractor X', 'SUBCONTRACTOR', 1, '5200000.00'],
    ]);
  });

  it('asks which firm an adjustment is for when there are two, and rounds it on that payslip', async () => {
    const c = await company();
    const { workerId } = await movedWorker(c);
    const bonus = { type: 'BONUS', amount: '1400' };

    const needed = await c.agent.post(`/api/adjustments/2026/9/${workerId}`).send(bonus).expect(400);
    expect(needed.body.issues).toEqual([{ path: 'firmId', message: 'validation.required' }]);
    const other = await firm(c.agent, 'Third', 'OWN');
    const wrong = await c.agent.post(`/api/adjustments/2026/9/${workerId}`).send({ ...bonus, firmId: other }).expect(409);
    expect(wrong.body.code).toBe('adjustment.firmNotInMonth');
    await c.agent.post(`/api/adjustments/2026/9/${workerId}`).send({ ...bonus, firmId: c.own }).expect(201);

    const view = (await c.agent.get('/api/payroll/2026/9').expect(200)).body.workers[0];
    expect(view.payslips[0]).toMatchObject({ total: '3601000.00' });
    expect(view.payslips[0].payOut.adjustments).toHaveLength(1);
    expect(view.payslips[1]).toMatchObject({ total: '5200000.00' });
    expect(view.payslips[1].payOut.adjustments).toEqual([]);
    expect(view.total).toBe('8801000.00');

    const row = (await c.agent.get('/api/adjustments/2026/9').expect(200)).body.rows[0];
    expect(row.firms.map((f: { name: string }) => f.name)).toEqual(['Perform MEP', 'Subcontractor X']);
    expect(row.adjustments[0].firm.name).toBe('Perform MEP');
  });

  it('holds back a worker with an adjustment that fits no payslip, until it is cancelled', async () => {
    const c = await company();
    const { workerId } = await movedWorker(c);
    await ctx.prisma.adjustment.create({
      data: { companyId: c.company.id, workerId, year: 2026, month: 9, type: 'BONUS', amount: '1000', setById: c.user.id },
    });
    const view = (await c.agent.get('/api/payroll/2026/9').expect(200)).body.workers[0];
    expect(view.problems).toEqual([{ code: 'adjustmentWithoutFirm' }]);
    expect(view.total).toBeNull();
    expect(view.parts).toEqual([]);
  });

  it('says which firm has no salary', async () => {
    const c = await company();
    const workerId = (await hire(c.agent, { siteId: c.site, firmId: c.own }).expect(201)).body.id as string;
    await c.agent.post(`/api/workers/${workerId}/placements`).send({ siteId: c.site, firmId: c.sub, from: '2026-09-16' }).expect(204);
    await salary(c.agent, workerId, c.own, '7500000').expect(201);
    const placements = await ctx.prisma.assignment.findMany({ where: { workerId }, orderBy: { hiredOn: 'asc' } });
    await c.agent.post(`/api/monthly-hours/2026/9/${placements[0].id}`).send(FIRST_HALF).expect(201);
    await c.agent.post(`/api/monthly-hours/2026/9/${placements[1].id}`).send(SECOND_HALF).expect(201);

    const month = (await c.agent.get('/api/payroll/2026/9').expect(200)).body;
    expect(month.workers[0].problems).toEqual([{ code: 'noSalary', firmName: 'Subcontractor X' }]);
    expect(month.firms.map((f: { withProblems: number }) => f.withProblems)).toEqual([1, 1]);
  });

  it('shows the same results for a locked month, with one snapshot total for the worker', async () => {
    const c = await company();
    const { workerId } = await movedWorker(c);
    await c.agent.post('/api/payroll/2026/9/lock').expect(201);
    const saved = await ctx.prisma.payrollSnapshotWorker.findFirstOrThrow({ where: { workerId } });
    expect(saved.total.toFixed(2)).toBe('8800000.00');
    const month = (await c.agent.get('/api/payroll/2026/9').expect(200)).body;
    expect(month.locked).toBe(true);
    expect(month.workers[0].payslips).toHaveLength(2);
    expect(month.firms).toHaveLength(2);
  });

  it('ignores firms while switched off', async () => {
    const c = await company();
    await movedWorker(c);
    await c.agent.put('/api/firms/settings').send({ enabled: false }).expect(204);
    const view = (await c.agent.get('/api/payroll/2026/9').expect(200)).body.workers[0];
    expect(view.firms).toBeUndefined();
    expect(view.payslips).toHaveLength(1);
    expect(view.payslips[0].firm).toBeNull();
    // The newest salary counts for all the days: 225 hours of 10 000 000 / 225.
    expect(view.total).toBe('10000000.00');
    expect(view.payOut).not.toBeNull();
  });
});

describe('pay rules per firm', () => {
  it("uses the firm's rules over the site's and the default, only from their first month", async () => {
    const c = await company();
    await c.agent.put(`/api/firms/${c.sub}/pay-rules/2026/10`).send({ ...RULES, normalHoursPerDay: '8' }).expect(204);
    const worker = (await hire(c.agent, { siteId: c.site, firmId: c.sub }).expect(201)).body.id as string;
    await salary(c.agent, worker, c.sub, '10000000').expect(201);
    const placement = (await ctx.prisma.assignment.findFirstOrThrow({ where: { workerId: worker } })).id;

    // September comes before the firm's rules: the company default, 9 hours.
    await c.agent.post(`/api/monthly-hours/2026/9/${placement}`).send(totals('2026-09-01', '2026-09-30', '225', 25)).expect(201);
    let view = (await c.agent.get('/api/payroll/2026/9').expect(200)).body.workers[0];
    expect(view.parts[0].ruleSetFirmName).toBeUndefined();
    expect(view.total).toBe('10000000.00');

    // October: the firm's own rules, 8 hours a day.
    const october = (await c.agent.get(`/api/firms/${c.sub}/working-days?year=2026`).expect(200)).body.months[9];
    expect(october.rulesFrom).toEqual({ year: 2026, month: 10 });
    const days = october.effective as number;
    await c.agent
      .post(`/api/monthly-hours/2026/10/${placement}`)
      .send(totals('2026-10-01', '2026-10-31', String(days * 8), days))
      .expect(201);
    view = (await c.agent.get('/api/payroll/2026/10').expect(200)).body.workers[0];
    expect(view.problems).toEqual([]);
    expect(view.parts[0].ruleSetFirmName).toBe('Subcontractor X');
    expect(view.total).toBe('10000000.00');
  });

  it('keeps the rounding step company-wide, and lets only owners and admins change firm rules', async () => {
    const c = await company();
    const accountant = await member(c.company.id, 'ACCOUNTANT');
    await accountant.agent.put(`/api/firms/${c.own}/pay-rules/2026/9`).send(RULES).expect(403);
    await c.agent.put(`/api/firms/${c.own}/pay-rules/2026/9`).send({ ...RULES, payRoundingStep: '5' }).expect(204);
    const rows = (await accountant.agent.get(`/api/firms/${c.own}/pay-rules`).expect(200)).body;
    expect(rows[0].rules.payRoundingStep).toBeUndefined();
    const stored = await ctx.prisma.payrollRules.findFirstOrThrow({ where: { ruleSet: { firmId: c.own } } });
    expect(stored.payRoundingStep).toBeNull();
    await c.agent.delete(`/api/firms/${c.own}/pay-rules/2026/9`).expect(204);
    expect((await c.agent.get(`/api/firms/${c.own}/pay-rules`).expect(200)).body).toEqual([]);
  });

  it('overrides the working days of the firm alone', async () => {
    const c = await company();
    await c.agent.put(`/api/firms/${c.own}/pay-rules/2026/9`).send(RULES).expect(204);
    await c.agent.post(`/api/firms/${c.own}/working-days/2026/9`).send({ workingDays: 20, reason: 'Short month' }).expect(204);
    expect((await c.agent.get(`/api/firms/${c.own}/working-days?year=2026`).expect(200)).body.months[8].effective).toBe(20);
    expect((await c.agent.get('/api/working-days?year=2026').expect(200)).body.months[8].effective).toBe(25);
  });
});

describe('Excel import with firms', () => {
  const HEADERS = ['SICIL', 'SOYADI', 'ADI', 'Statu', 'Фирма', 'Santiye', 'GIRIS TARIHI', 'CIKIS TARIHI', 'MAAS'];
  const isOff = (day: number) => day === 1 || new Date(Date.UTC(2026, 8, day)).getUTCDay() === 0;
  const daysIn = (first: number, last: number) =>
    [...Array(30).keys()].map((i) => (i + 1 < first || i + 1 > last ? null : isOff(i + 1) ? 'T' : 9));

  async function workbook(rows: (string | number | Date | null)[][]) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Timesheet');
    ws.addRow([...HEADERS, ...[...Array(30).keys()].map((i) => i + 1)]);
    rows.forEach((r) => ws.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  const send = (agent: Agent, path: string, file: Buffer) =>
    agent.post(`/api/imports/${path}`).field('year', '2026').field('month', '9').attach('file', file, 'tabel.xlsx');

  async function withCodes() {
    const c = await company();
    await c.agent
      .put('/api/timesheet-codes')
      .send({ codes: [{ code: 'T', status: 'OFF', inGrid: false }, { code: '-', status: 'NOT_EMPLOYED', inGrid: false }] })
      .expect(204);
    return c;
  }

  const hired = new Date(Date.UTC(2026, 8, 1));

  it('reads the firm column, and an unknown firm is a problem row', async () => {
    const c = await withCodes();
    const file = await workbook([
      ['1', 'Aliyev', 'Test', 'Direkt', 'perform mep', 'Site A', hired, null, 7500000, ...daysIn(1, 30)],
      ['2', 'Karimov', 'Test', 'Direkt', 'Nobody', 'Site A', hired, null, 7500000, ...daysIn(1, 30)],
    ]);
    const preview = (await send(c.agent, 'preview', file).expect(200)).body;
    expect(preview.mapping.columns.firm).toBe('Фирма');
    expect(preview.workers.problems).toMatchObject([{ row: 3, code: 'import.firmNotFound', field: 'firm', value: 'Nobody' }]);
    await send(c.agent, 'workers', file).expect(409);
    expect(await ctx.prisma.worker.count()).toBe(0);
  });

  it('adds a worker who moved firms from one row per firm, and imports the hours of both', async () => {
    const c = await withCodes();
    const file = await workbook([
      ['1', 'Aliyev', 'Test', 'Direkt', 'Subcontractor X', 'Site A', new Date(Date.UTC(2026, 8, 16)), null, 10000000, ...daysIn(16, 30)],
      ['1', 'Aliyev', 'Test', 'Direkt', 'Perform MEP', 'Site A', hired, new Date(Date.UTC(2026, 8, 15)), 7500000, ...daysIn(1, 15)],
    ]);
    const preview = (await send(c.agent, 'preview', file).expect(200)).body;
    expect(preview.workers).toMatchObject({ rows: 2, new: 1, problems: [] });

    expect((await send(c.agent, 'workers', file).expect(201)).body).toEqual({ created: 1 });
    const placements = await ctx.prisma.assignment.findMany({ orderBy: { hiredOn: 'asc' }, include: { firm: true } });
    expect(placements.map((p) => p.firm?.name)).toEqual(['Perform MEP', 'Subcontractor X']);
    expect(await ctx.prisma.worker.count()).toBe(1);

    const hoursPreview = (await send(c.agent, 'preview', file).expect(200)).body;
    expect(hoursPreview.hours).toMatchObject({ workers: 1, problems: [] });
    await send(c.agent, 'hours', file).expect(201);

    const view = (await c.agent.get('/api/payroll/2026/9').expect(200)).body.workers[0];
    expect(view.source).toBe('IMPORT');
    expect(view.payslips.map((p: { total: string }) => p.total)).toEqual(['3600000.00', '5200000.00']);
  });

  it('still refuses a worker twice for the same firm, and hours on days of the other firm', async () => {
    const c = await withCodes();
    const twice = await workbook([
      ['1', 'Aliyev', 'Test', 'Direkt', 'Perform MEP', 'Site A', hired, null, 7500000, ...daysIn(1, 30)],
      ['1', 'Aliyev', 'Test', 'Direkt', 'Perform MEP', 'Site A', hired, null, 7500000, ...daysIn(1, 30)],
    ]);
    const first = (await send(c.agent, 'preview', twice).expect(200)).body;
    expect(first.workers.problems.map((p: { code: string }) => p.code)).toEqual(['import.duplicateEmployeeNumber', 'import.duplicateEmployeeNumber']);

    const file = await workbook([
      ['1', 'Aliyev', 'Test', 'Direkt', 'Perform MEP', 'Site A', hired, new Date(Date.UTC(2026, 8, 15)), 7500000, ...daysIn(1, 15)],
      ['1', 'Aliyev', 'Test', 'Direkt', 'Subcontractor X', 'Site A', new Date(Date.UTC(2026, 8, 16)), null, 10000000, ...daysIn(16, 30)],
    ]);
    await send(c.agent, 'workers', file).expect(201);
    const wrong = await workbook([
      ['1', 'Aliyev', 'Test', 'Direkt', 'Perform MEP', 'Site A', hired, new Date(Date.UTC(2026, 8, 15)), 7500000, ...daysIn(1, 16)],
      ['1', 'Aliyev', 'Test', 'Direkt', 'Subcontractor X', 'Site A', new Date(Date.UTC(2026, 8, 16)), null, 10000000, ...daysIn(16, 30)],
    ]);
    const preview = (await send(c.agent, 'preview', wrong).expect(200)).body;
    expect(preview.hours.problems).toMatchObject([{ row: 2, code: 'import.valueWhileNotEmployed', days: [16] }]);
  });

  it('shows where the file names another firm than the app', async () => {
    const c = await withCodes();
    await hire(c.agent, { siteId: c.site, firmId: c.own }).expect(201);
    await ctx.prisma.worker.updateMany({ data: { employeeNumber: '1' } });
    const file = await workbook([['1', 'Testov', 'Test', 'Direkt', 'Subcontractor X', 'Site A', hired, null, null, ...daysIn(1, 30)]]);
    const preview = (await send(c.agent, 'preview', file).expect(200)).body;
    expect(preview.workers.changes).toMatchObject([{ field: 'firm', file: 'Subcontractor X', app: 'Perform MEP' }]);
  });
});
