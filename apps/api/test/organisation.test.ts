import type { Role } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dayToDate, isoDay, todayIn } from '../src/common/dates';
import { addMember, createUser, loginAs, memberOfNewCompany, resetDb, startApp, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => (ctx = await startApp()));
afterAll(async () => ctx.app.close());
beforeEach(async () => resetDb(ctx.prisma));

/** Made-up worker details. */
const WORKER = {
  lastName: 'Testov',
  firstName: 'Test',
  patronymic: '',
  position: 'Electrician',
  employmentType: 'DIRECT',
  pinfl: '12345678901234',
  birthDate: '1990-05-01',
  nationality: '',
  passportSeries: 'aa',
  passportNumber: '1234567',
  phone: '90 111 22 33',
};

/** A company with an owner, two sites and a team on site A. */
async function company() {
  const owner = await memberOfNewCompany(ctx, 'OWNER');
  const siteA = (await owner.agent.post('/api/sites').send({ name: 'Site A' }).expect(201)).body.id as string;
  const siteB = (await owner.agent.post('/api/sites').send({ name: 'Site B', code: '', address: '' }).expect(201)).body.id as string;
  const teamA = (await owner.agent.post('/api/teams').send({ siteId: siteA, name: 'Team A' }).expect(201)).body.id as string;
  return { ...owner, siteA, siteB, teamA };
}

/** A member of the company with a role, logged in. */
async function member(companyId: string, role: Role) {
  const user = await createUser(ctx.prisma);
  await addMember(ctx.prisma, user.id, companyId, role);
  return { user, agent: await loginAs(ctx.app, user.email!) };
}

async function hire(agent: Awaited<ReturnType<typeof company>>['agent'], siteId: string, teamId: string | null, extra = {}) {
  const res = await agent
    .post('/api/workers')
    .send({ worker: { ...WORKER, pinfl: '', ...extra }, placement: { siteId, teamId, from: '2026-09-01' } })
    .expect(201);
  return res.body.id as string;
}

/** The calendar day `n` days from today in the companies' time zone. */
function daysFromToday(n: number) {
  const date = dayToDate(todayIn('Asia/Tashkent'));
  date.setUTCDate(date.getUTCDate() + n);
  return isoDay(date);
}

async function lock(companyId: string, year: number, month: number) {
  const user = await createUser(ctx.prisma);
  await ctx.prisma.payrollPeriod.create({
    data: { companyId, year, month, status: 'LOCKED', lockedAt: new Date(), lockedById: user.id },
  });
}

describe('sites and teams', () => {
  it('lets owners and admins create and change sites, with audit records', async () => {
    const { company: c, agent, siteA, teamA } = await company();
    await agent.patch(`/api/sites/${siteA}`).send({ address: 'Tashkent' }).expect(204);
    const sites = (await agent.get('/api/sites').expect(200)).body;
    expect(sites).toHaveLength(2);
    expect(sites[0]).toMatchObject({
      name: 'Site A',
      address: 'Tashkent',
      code: null,
      teams: [{ id: teamA, name: 'Team A', foremen: [], workerCount: 0 }],
      staff: [],
      workerCount: 0,
    });
    const actions = (await ctx.prisma.auditLog.findMany({ where: { companyId: c.id }, orderBy: { createdAt: 'asc' } })).map((l) => l.action);
    expect(actions).toEqual(['site.create', 'site.create', 'team.create', 'site.update']);
  });

  it('refuses duplicate names and deactivating a site or team that still has workers', async () => {
    const { agent, siteA, teamA } = await company();
    expect((await agent.post('/api/sites').send({ name: 'Site A' }).expect(409)).body.code).toBe('site.nameTaken');
    expect((await agent.post('/api/teams').send({ siteId: siteA, name: 'Team A' }).expect(409)).body.code).toBe('team.nameTaken');

    const worker = await hire(agent, siteA, teamA);
    expect((await agent.patch(`/api/teams/${teamA}`).send({ isActive: false }).expect(409)).body.code).toBe('team.hasWorkers');
    expect((await agent.patch(`/api/sites/${siteA}`).send({ isActive: false }).expect(409)).body.code).toBe('site.hasWorkers');

    await agent.post(`/api/workers/${worker}/leave`).send({ date: '2026-09-30' }).expect(204);
    await agent.patch(`/api/teams/${teamA}`).send({ isActive: false }).expect(204);
    await agent.patch(`/api/sites/${siteA}`).send({ isActive: false }).expect(204);
    expect((await agent.post('/api/teams').send({ siteId: siteA, name: 'Team B' }).expect(409)).body.code).toBe('site.inactive');
  });

  it('refuses closing a site or team that a worker is placed in from a later day', async () => {
    const { agent, siteA, siteB, teamA } = await company();
    const worker = await hire(agent, siteB, null);
    await agent.post(`/api/workers/${worker}/placements`).send({ siteId: siteA, teamId: teamA, from: daysFromToday(7) }).expect(204);
    expect((await agent.patch(`/api/teams/${teamA}`).send({ isActive: false }).expect(409)).body.code).toBe('team.hasWorkers');
    expect((await agent.patch(`/api/sites/${siteA}`).send({ isActive: false }).expect(409)).body.code).toBe('site.hasWorkers');
  });

  it('lets a project manager manage teams only on their own sites, never create sites', async () => {
    const { company: c, agent, siteA, siteB } = await company();
    const pm = await member(c.id, 'PROJECT_MANAGER');
    await agent.post(`/api/sites/${siteA}/staff`).send({ userId: pm.user.id }).expect(204);

    await pm.agent.post('/api/sites').send({ name: 'Site C' }).expect(403);
    const sites = (await pm.agent.get('/api/sites').expect(200)).body;
    expect(sites.map((s: { id: string }) => s.id)).toEqual([siteA]);
    await pm.agent.post('/api/teams').send({ siteId: siteA, name: 'Team PM' }).expect(201);
    // Another site looks like it doesn't exist.
    await pm.agent.post('/api/teams').send({ siteId: siteB, name: 'Team PM' }).expect(404);
  });

  it('only shows accountants, timekeepers and foremen what they may see, and lets them change nothing', async () => {
    const { company: c, agent, siteA, teamA } = await company();
    const accountant = await member(c.id, 'ACCOUNTANT');
    const timekeeper = await member(c.id, 'TIMEKEEPER');
    const foreman = await member(c.id, 'FOREMAN');
    await agent.post(`/api/sites/${siteA}/staff`).send({ userId: timekeeper.user.id }).expect(204);
    await agent.post(`/api/teams/${teamA}/foremen`).send({ userId: foreman.user.id }).expect(204);

    expect((await accountant.agent.get('/api/sites').expect(200)).body).toHaveLength(2);
    expect((await timekeeper.agent.get('/api/sites').expect(200)).body.map((s: { id: string }) => s.id)).toEqual([siteA]);
    const foremanSites = (await foreman.agent.get('/api/sites').expect(200)).body;
    expect(foremanSites.map((s: { id: string }) => s.id)).toEqual([siteA]);
    expect(foremanSites[0].teams.map((t: { id: string }) => t.id)).toEqual([teamA]);

    for (const { agent: other } of [accountant, timekeeper, foreman]) {
      await other.post('/api/sites').send({ name: 'X' }).expect(403);
      await other.post('/api/teams').send({ siteId: siteA, name: 'X' }).expect(403);
      await other.post('/api/workers').send({}).expect(403);
    }
  });
});

describe('who works where', () => {
  it('lets owners assign project managers and timekeepers to sites and foremen to teams', async () => {
    const { company: c, agent, siteA, teamA } = await company();
    const pm = await member(c.id, 'PROJECT_MANAGER');
    const tk = await member(c.id, 'TIMEKEEPER');
    const fm = await member(c.id, 'FOREMAN');
    await agent.post(`/api/sites/${siteA}/staff`).send({ userId: pm.user.id }).expect(204);
    await agent.post(`/api/sites/${siteA}/staff`).send({ userId: tk.user.id }).expect(204);
    await agent.post(`/api/teams/${teamA}/foremen`).send({ userId: fm.user.id }).expect(204);

    const site = (await agent.get('/api/sites').expect(200)).body.find((s: { id: string }) => s.id === siteA);
    expect(site.staff.map((s: { role: string }) => s.role).sort()).toEqual(['PROJECT_MANAGER', 'TIMEKEEPER']);
    expect(site.teams[0].foremen).toEqual([{ userId: fm.user.id, fullName: fm.user.fullName, role: 'FOREMAN' }]);

    // Roles that aren't assigned this way are refused.
    expect((await agent.post(`/api/sites/${siteA}/staff`).send({ userId: fm.user.id }).expect(400)).body.code).toBe('staff.wrongRole');
    expect((await agent.post(`/api/teams/${teamA}/foremen`).send({ userId: tk.user.id }).expect(400)).body.code).toBe('staff.wrongRole');

    await agent.delete(`/api/sites/${siteA}/staff/${tk.user.id}`).expect(204);
    await agent.delete(`/api/teams/${teamA}/foremen/${fm.user.id}`).expect(204);
    expect(await ctx.prisma.memberSite.count()).toBe(1);
    expect(await ctx.prisma.memberTeam.count()).toBe(0);
  });

  it('lets a project manager assign timekeepers and foremen on their own sites, but not project managers', async () => {
    const { company: c, agent, siteA, siteB, teamA } = await company();
    const pm = await member(c.id, 'PROJECT_MANAGER');
    const otherPm = await member(c.id, 'PROJECT_MANAGER');
    const tk = await member(c.id, 'TIMEKEEPER');
    const fm = await member(c.id, 'FOREMAN');
    await agent.post(`/api/sites/${siteA}/staff`).send({ userId: pm.user.id }).expect(204);

    await pm.agent.post(`/api/sites/${siteA}/staff`).send({ userId: tk.user.id }).expect(204);
    await pm.agent.post(`/api/teams/${teamA}/foremen`).send({ userId: fm.user.id }).expect(204);
    await pm.agent.post(`/api/sites/${siteA}/staff`).send({ userId: otherPm.user.id }).expect(403);
    await pm.agent.delete(`/api/sites/${siteA}/staff/${pm.user.id}`).expect(403);
    await pm.agent.post(`/api/sites/${siteB}/staff`).send({ userId: tk.user.id }).expect(404);

    // The picker offers a project manager only the roles they may assign.
    const offered = (await pm.agent.get('/api/sites/staff-candidates').expect(200)).body;
    expect(offered.map((m: { role: string }) => m.role).sort()).toEqual(['FOREMAN', 'TIMEKEEPER']);
    const all = (await agent.get('/api/sites/staff-candidates').expect(200)).body;
    expect(all.map((m: { role: string }) => m.role).sort()).toEqual(['FOREMAN', 'PROJECT_MANAGER', 'PROJECT_MANAGER', 'TIMEKEEPER']);
    expect(Object.keys(all[0]).sort()).toEqual(['fullName', 'role', 'userId']);
  });
});

describe('workers', () => {
  it('adds a worker with a first placement and shows personal data only to those who may see it', async () => {
    const { company: c, agent, siteA, teamA } = await company();
    const res = await agent
      .post('/api/workers')
      .send({ worker: { ...WORKER, employeeNumber: ' 10001 ' }, placement: { siteId: siteA, teamId: teamA, from: '2026-09-01' } })
      .expect(201);
    const full = (await agent.get(`/api/workers/${res.body.id}`).expect(200)).body;
    expect(full).toEqual({
      id: res.body.id,
      employeeNumber: '10001',
      lastName: 'Testov',
      firstName: 'Test',
      patronymic: null,
      position: 'Electrician',
      employmentType: 'DIRECT',
      placement: {
        id: expect.any(String),
        siteId: siteA,
        siteName: 'Site A',
        teamId: teamA,
        teamName: 'Team A',
        // The company doesn't use departments, and the team has none.
        departmentId: null,
        departmentName: null,
        from: '2026-09-01',
        until: null,
      },
      shift: null,
      personal: {
        pinfl: '12345678901234',
        birthDate: '1990-05-01',
        nationality: null,
        passportSeries: 'AA',
        passportNumber: '1234567',
        phone: '+998901112233',
      },
      salary: null,
    });

    const tk = await member(c.id, 'TIMEKEEPER');
    await agent.post(`/api/sites/${siteA}/staff`).send({ userId: tk.user.id }).expect(204);
    const seen = (await tk.agent.get('/api/workers').expect(200)).body;
    expect(seen).toHaveLength(1);
    expect(seen[0].personal).toBeNull();
    expect(JSON.stringify(seen)).not.toContain('12345678901234');

    const accountant = await member(c.id, 'ACCOUNTANT');
    expect((await accountant.agent.get('/api/workers').expect(200)).body[0].personal.pinfl).toBe('12345678901234');

    const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'worker.create' } });
    expect(JSON.stringify(log.data)).not.toContain('12345678901234');
  });

  it('refuses a PINFL or employee number already used in the company, and a team from another site', async () => {
    const { agent, siteA, siteB, teamA } = await company();
    const first = await hire(agent, siteA, teamA, { pinfl: '12345678901234', employeeNumber: '7' });
    const numberTaken = await agent
      .post('/api/workers')
      .send({ worker: { ...WORKER, pinfl: '', employeeNumber: '7' }, placement: { siteId: siteA, teamId: null, from: '2026-09-01' } })
      .expect(409);
    expect(numberTaken.body.code).toBe('worker.employeeNumberTaken');
    // Saving the worker with their own number again is fine.
    await agent.patch(`/api/workers/${first}`).send({ ...WORKER, employeeNumber: '7' }).expect(204);
    // Another company may use the same number.
    const other = await company();
    await hire(other.agent, other.siteA, other.teamA, { pinfl: '', employeeNumber: '7' });
    const dup = await agent
      .post('/api/workers')
      .send({ worker: WORKER, placement: { siteId: siteA, teamId: null, from: '2026-09-01' } })
      .expect(409);
    expect(dup.body.code).toBe('worker.pinflTaken');
    const wrongTeam = await agent
      .post('/api/workers')
      .send({ worker: { ...WORKER, pinfl: '' }, placement: { siteId: siteB, teamId: teamA, from: '2026-09-01' } })
      .expect(400);
    expect(wrongTeam.body.issues).toEqual([{ path: 'placement.teamId', message: 'validation.teamNotOnSite' }]);
  });

  it('moves a worker to another site from a day, keeping the old placement as history', async () => {
    const { agent, siteA, siteB, teamA } = await company();
    const id = await hire(agent, siteA, teamA);
    const early = await agent.post(`/api/workers/${id}/placements`).send({ siteId: siteB, from: '2026-09-01' }).expect(400);
    expect(early.body.issues).toEqual([{ path: 'from', message: 'validation.placementBeforeCurrent' }]);

    await agent.post(`/api/workers/${id}/placements`).send({ siteId: siteB, teamId: null, from: '2026-10-15' }).expect(204);
    const worker = (await agent.get(`/api/workers/${id}`).expect(200)).body;
    expect(worker.placement).toMatchObject({ siteId: siteB, teamId: null, from: '2026-10-15', until: null });
    const placements = await ctx.prisma.assignment.findMany({ where: { workerId: id }, orderBy: { hiredOn: 'asc' } });
    expect(placements.map((p) => [p.siteId, p.leftOn?.toISOString().slice(0, 10) ?? null])).toEqual([
      [siteA, '2026-10-14'],
      [siteB, null],
    ]);
  });

  it('records leaving and coming back', async () => {
    const { agent, siteA } = await company();
    const id = await hire(agent, siteA, null);
    const before = await agent.post(`/api/workers/${id}/leave`).send({ date: '2026-08-31' }).expect(400);
    expect(before.body.issues).toEqual([{ path: 'date', message: 'validation.leaveBeforeStart' }]);
    await agent.post(`/api/workers/${id}/leave`).send({ date: '2026-09-20' }).expect(204);
    expect((await agent.get(`/api/workers/${id}`).expect(200)).body.placement.until).toBe('2026-09-20');

    await agent.post(`/api/workers/${id}/placements`).send({ siteId: siteA, from: '2026-11-01' }).expect(204);
    const placements = await ctx.prisma.assignment.count({ where: { workerId: id } });
    expect(placements).toBe(2);
  });

  it('refuses changes that reach into a locked month', async () => {
    const { company: c, agent, siteA, siteB } = await company();
    const id = await hire(agent, siteA, null);
    await lock(c.id, 2026, 10);
    expect((await agent.post(`/api/workers/${id}/leave`).send({ date: '2026-09-20' }).expect(409)).body.code).toBe('period.locked');
    await agent.post(`/api/workers/${id}/placements`).send({ siteId: siteB, from: '2026-09-15' }).expect(409);
    const hired = await agent
      .post('/api/workers')
      .send({ worker: { ...WORKER, pinfl: '' }, placement: { siteId: siteA, from: '2026-10-05' } })
      .expect(409);
    expect(hired.body.code).toBe('period.locked');
  });

  it("lets a project manager manage only their own sites' workers", async () => {
    const { company: c, agent, siteA, siteB } = await company();
    const pm = await member(c.id, 'PROJECT_MANAGER');
    await agent.post(`/api/sites/${siteA}/staff`).send({ userId: pm.user.id }).expect(204);
    const mine = await hire(pm.agent, siteA, null);
    const theirs = await hire(agent, siteB, null);

    expect((await pm.agent.get('/api/workers').expect(200)).body.map((w: { id: string }) => w.id)).toEqual([mine]);
    await pm.agent.get(`/api/workers/${theirs}`).expect(404);
    await pm.agent.patch(`/api/workers/${theirs}`).send({ ...WORKER, pinfl: '' }).expect(404);
    // Can't move their worker away to a site they don't manage.
    await pm.agent.post(`/api/workers/${mine}/placements`).send({ siteId: siteB, from: '2026-10-01' }).expect(403);
    await pm.agent
      .post('/api/workers')
      .send({ worker: { ...WORKER, pinfl: '' }, placement: { siteId: siteB, from: '2026-09-01' } })
      .expect(403);
  });

  it('shows a foreman only the workers of their own teams', async () => {
    const { company: c, agent, siteA, teamA } = await company();
    const teamB = (await agent.post('/api/teams').send({ siteId: siteA, name: 'Team B' }).expect(201)).body.id;
    const fm = await member(c.id, 'FOREMAN');
    await agent.post(`/api/teams/${teamA}/foremen`).send({ userId: fm.user.id }).expect(204);
    const inA = await hire(agent, siteA, teamA);
    await hire(agent, siteA, teamB);
    await hire(agent, siteA, null);
    expect((await fm.agent.get('/api/workers').expect(200)).body.map((w: { id: string }) => w.id)).toEqual([inA]);
  });

  it('keeps showing a worker to their team until a planned move, and not after a past one', async () => {
    const { company: c, agent, siteA, teamA } = await company();
    const teamB = (await agent.post('/api/teams').send({ siteId: siteA, name: 'Team B' }).expect(201)).body.id;
    const [fmA, fmB] = [await member(c.id, 'FOREMAN'), await member(c.id, 'FOREMAN')];
    await agent.post(`/api/teams/${teamA}/foremen`).send({ userId: fmA.user.id }).expect(204);
    await agent.post(`/api/teams/${teamB}/foremen`).send({ userId: fmB.user.id }).expect(204);
    const ids = async (fm: typeof fmA) => (await fm.agent.get('/api/workers').expect(200)).body.map((w: { id: string }) => w.id);

    const moving = await hire(agent, siteA, teamA);
    await agent.post(`/api/workers/${moving}/placements`).send({ siteId: siteA, teamId: teamB, from: daysFromToday(7) }).expect(204);
    expect(await ids(fmA)).toEqual([moving]);
    await fmA.agent.get(`/api/workers/${moving}`).expect(200);
    expect(await ids(fmB)).toEqual([moving]);

    const moved = await hire(agent, siteA, teamA, { firstName: 'Moved' });
    await agent.post(`/api/workers/${moved}/placements`).send({ siteId: siteA, teamId: teamB, from: '2026-10-01' }).expect(204);
    expect(await ids(fmA)).toEqual([moving]);
    await fmA.agent.get(`/api/workers/${moved}`).expect(404);
  });

  it('edits worker details, recording which personal fields changed but not their values', async () => {
    const { agent, siteA } = await company();
    const id = await hire(agent, siteA, null);
    await agent.patch(`/api/workers/${id}`).send({ ...WORKER, pinfl: '', position: 'Foreman', passportNumber: '7654321' }).expect(204);
    const worker = (await agent.get(`/api/workers/${id}`).expect(200)).body;
    expect(worker).toMatchObject({ position: 'Foreman', personal: { passportNumber: '7654321' } });
    const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'worker.update' } });
    expect(log.data).toEqual({
      changes: { position: { from: 'Electrician', to: 'Foreman' }, passportNumber: 'changed' },
    });
  });
});

describe('salaries', () => {
  const salary = (fromYear: number, fromMonth: number, monthlySalary: string, reason = '') => ({
    fromYear,
    fromMonth,
    monthlySalary,
    reason,
  });

  it('lets an accountant add salaries from a month, newest first, with corrections and audit records', async () => {
    const { company: c, agent, siteA } = await company();
    const id = await hire(agent, siteA, null);
    const accountant = await member(c.id, 'ACCOUNTANT');
    expect((await accountant.agent.get(`/api/workers/${id}`).expect(200)).body.salary).toBeNull();

    await accountant.agent.post(`/api/workers/${id}/salaries`).send(salary(2026, 9, '5 000 000')).expect(201);
    await accountant.agent.post(`/api/workers/${id}/salaries`).send(salary(2026, 11, '6000000', 'Raise')).expect(201);
    // The same amount as the salary already in force changes nothing.
    const same = await accountant.agent.post(`/api/workers/${id}/salaries`).send(salary(2026, 10, '5000000')).expect(409);
    expect(same.body.code).toBe('salary.unchanged');
    // A newer salary from the same month corrects the older one.
    await agent.post(`/api/workers/${id}/salaries`).send(salary(2026, 11, '6500000', 'Typo')).expect(201);

    const history = (await accountant.agent.get(`/api/workers/${id}/salaries`).expect(200)).body;
    expect(history.map((h: { fromMonth: number; monthlySalary: string; corrected: boolean }) => [h.fromMonth, h.monthlySalary, h.corrected])).toEqual([
      [11, '6500000', false],
      [11, '6000000', true],
      [9, '5000000', false],
    ]);
    expect(history[0]).toMatchObject({ reason: 'Typo', setBy: { fullName: expect.any(String) } });
    expect((await agent.get(`/api/workers/${id}`).expect(200)).body.salary).toEqual({
      fromYear: 2026,
      fromMonth: 11,
      monthlySalary: '6500000',
    });

    const log = await ctx.prisma.auditLog.findMany({ where: { action: 'salary.add' }, orderBy: { createdAt: 'asc' } });
    expect(log.map((l) => l.data)).toEqual([
      expect.objectContaining({ fromMonth: 9, from: null, to: '5000000' }),
      expect.objectContaining({ fromMonth: 11, from: '5000000', to: '6000000', reason: 'Raise' }),
      expect.objectContaining({ fromMonth: 11, from: '6000000', to: '6500000', reason: 'Typo' }),
    ]);
  });

  it('refuses a salary of 0 or a month that is not one', async () => {
    const { agent, siteA } = await company();
    const id = await hire(agent, siteA, null);
    const res = await agent.post(`/api/workers/${id}/salaries`).send(salary(2026, 13, '0')).expect(400);
    expect(res.body.issues).toEqual([
      { path: 'fromMonth', message: 'validation.invalid' },
      { path: 'monthlySalary', message: 'validation.salaryRange' },
    ]);
  });

  it('refuses a salary that would change a locked month, up to the next salary', async () => {
    const { company: c, agent, siteA } = await company();
    const id = await hire(agent, siteA, null);
    await agent.post(`/api/workers/${id}/salaries`).send(salary(2026, 11, '6000000')).expect(201);
    await lock(c.id, 2026, 12);
    // September and October only: November on has its own salary.
    await agent.post(`/api/workers/${id}/salaries`).send(salary(2026, 9, '5000000')).expect(201);
    await lock(c.id, 2026, 10);
    const res = await agent.post(`/api/workers/${id}/salaries`).send(salary(2026, 9, '5500000')).expect(409);
    expect(res.body.code).toBe('period.locked');
    expect((await agent.post(`/api/workers/${id}/salaries`).send(salary(2026, 11, '6100000')).expect(409)).body.code).toBe('period.locked');
    await agent.post(`/api/workers/${id}/salaries`).send(salary(2027, 1, '7000000')).expect(201);
  });

  it('never shows salaries to timekeepers or foremen, and lets project managers only view them on their sites', async () => {
    const { company: c, agent, siteA, siteB, teamA } = await company();
    const id = await hire(agent, siteA, teamA);
    const elsewhere = await hire(agent, siteB, null);
    await agent.post(`/api/workers/${id}/salaries`).send(salary(2026, 9, '5123000')).expect(201);
    await agent.post(`/api/workers/${elsewhere}/salaries`).send(salary(2026, 9, '5000000')).expect(201);

    const tk = await member(c.id, 'TIMEKEEPER');
    await agent.post(`/api/sites/${siteA}/staff`).send({ userId: tk.user.id }).expect(204);
    const fm = await member(c.id, 'FOREMAN');
    await agent.post(`/api/teams/${teamA}/foremen`).send({ userId: fm.user.id }).expect(204);
    for (const field of [tk, fm]) {
      const workers = (await field.agent.get('/api/workers').expect(200)).body;
      expect(workers.map((w: { salary: unknown }) => w.salary)).toEqual([null]);
      expect(JSON.stringify(workers)).not.toContain('5123000');
      await field.agent.get(`/api/workers/${id}/salaries`).expect(403);
      await field.agent.post(`/api/workers/${id}/salaries`).send(salary(2026, 10, '1000000')).expect(403);
    }

    const pm = await member(c.id, 'PROJECT_MANAGER');
    await agent.post(`/api/sites/${siteA}/staff`).send({ userId: pm.user.id }).expect(204);
    expect((await pm.agent.get(`/api/workers/${id}/salaries`).expect(200)).body).toHaveLength(1);
    await pm.agent.get(`/api/workers/${elsewhere}/salaries`).expect(404);
    await pm.agent.post(`/api/workers/${id}/salaries`).send(salary(2026, 10, '6000000')).expect(403);
    expect(await ctx.prisma.salary.count()).toBe(2);
  });
});

describe('tenant isolation', () => {
  it("never shows or changes another company's sites, teams, workers or staff", async () => {
    const a = await company();
    const b = await company();
    const bWorker = await hire(b.agent, b.siteA, b.teamA);
    const bTk = await member(b.company.id, 'TIMEKEEPER');

    expect((await a.agent.get('/api/sites').expect(200)).body.map((s: { id: string }) => s.id).sort()).toEqual(
      [a.siteA, a.siteB].sort(),
    );
    expect((await a.agent.get('/api/workers').expect(200)).body).toEqual([]);
    await a.agent.get(`/api/workers/${bWorker}`).expect(404);
    await a.agent.patch(`/api/sites/${b.siteA}`).send({ name: 'Taken over' }).expect(404);
    await a.agent.patch(`/api/teams/${b.teamA}`).send({ name: 'Taken over' }).expect(404);
    await a.agent.post('/api/teams').send({ siteId: b.siteA, name: 'Sneaky' }).expect(404);
    await a.agent.post(`/api/workers/${bWorker}/leave`).send({ date: '2026-09-30' }).expect(404);
    await a.agent.get(`/api/workers/${bWorker}/salaries`).expect(404);
    await a.agent
      .post(`/api/workers/${bWorker}/salaries`)
      .send({ fromYear: 2026, fromMonth: 9, monthlySalary: '5000000' })
      .expect(404);
    expect(await ctx.prisma.salary.count()).toBe(0);
    await a.agent.post(`/api/sites/${b.siteA}/staff`).send({ userId: bTk.user.id }).expect(404);
    // B's member can't be assigned to A's site either.
    await a.agent.post(`/api/sites/${a.siteA}/staff`).send({ userId: bTk.user.id }).expect(404);
    // A's site in B's worker placement is refused.
    await b.agent.post(`/api/workers/${bWorker}/placements`).send({ siteId: a.siteA, from: '2026-10-01' }).expect(404);
    expect(await ctx.prisma.site.count({ where: { name: 'Taken over' } })).toBe(0);
  });
});
