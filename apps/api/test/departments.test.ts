import type { Role } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, createUser, loginAs, memberOfNewCompany, resetDb, startApp, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => (ctx = await startApp()));
afterAll(async () => ctx.app.close());
beforeEach(async () => resetDb(ctx.prisma));

type Agent = Awaited<ReturnType<typeof memberOfNewCompany>>['agent'];

/** A company with a site, HSE (with HSE Site A under it) and QA/QC, departments not yet on. */
async function company() {
  const owner = await memberOfNewCompany(ctx, 'OWNER');
  const site = (await owner.agent.post('/api/sites').send({ name: 'Site A' }).expect(201)).body.id as string;
  const hse = await department(owner.agent, { name: 'HSE' });
  const hseSiteA = await department(owner.agent, { name: 'HSE Site A', parentId: hse });
  const qa = await department(owner.agent, { name: 'QA/QC', code: 'QA' });
  return { ...owner, site, hse, hseSiteA, qa };
}

async function department(agent: Agent, body: { name: string; code?: string; parentId?: string }) {
  return (await agent.post('/api/departments').send(body).expect(201)).body.id as string;
}

async function member(companyId: string, role: Role) {
  const user = await createUser(ctx.prisma);
  await addMember(ctx.prisma, user.id, companyId, role);
  return { user, agent: await loginAs(ctx.app, user.email!) };
}

const hire = (agent: Agent, placement: { siteId: string; teamId?: string | null; departmentId?: string | null }) =>
  agent
    .post('/api/workers')
    .send({ worker: { lastName: 'Testov', firstName: 'Test', employmentType: 'DIRECT' }, placement: { ...placement, from: '2026-09-01' } });

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

/** Every working day of September 2026 at normal hours. */
const FULL_MONTH = {
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
};

const turnOn =(agent: Agent) => agent.put('/api/departments/settings').send({ enabled: true }).expect(204);

describe('departments', () => {
  it('lets owners and admins build the tree; everyone sees it', async () => {
    const { company: c, agent, hse, hseSiteA, qa } = await company();
    const foreman = await member(c.id, 'FOREMAN');
    const pm = await member(c.id, 'PROJECT_MANAGER');
    await pm.agent.post('/api/departments').send({ name: 'IT' }).expect(403);
    await pm.agent.patch(`/api/departments/${qa}`).send({ name: 'QC' }).expect(403);
    await pm.agent.put('/api/departments/settings').send({ enabled: true }).expect(403);

    expect((await foreman.agent.get('/api/departments').expect(200)).body).toEqual([
      { id: hse, parentId: null, name: 'HSE', code: null, isActive: true },
      { id: hseSiteA, parentId: hse, name: 'HSE Site A', code: null, isActive: true },
      { id: qa, parentId: null, name: 'QA/QC', code: 'QA', isActive: true },
    ]);
    const actions = (await ctx.prisma.auditLog.findMany({ where: { companyId: c.id }, orderBy: { createdAt: 'asc' } })).map((l) => l.action);
    expect(actions.filter((a) => a.startsWith('department'))).toEqual(['department.create', 'department.create', 'department.create']);
  });

  it('keeps names unique among siblings, ignoring case, and allows them elsewhere in the tree', async () => {
    const { agent, hse, qa } = await company();
    expect((await agent.post('/api/departments').send({ name: 'hse' }).expect(409)).body.code).toBe('department.nameTaken');
    await department(agent, { name: 'Site A', parentId: hse });
    await department(agent, { name: 'Site A', parentId: qa });
    const res = await agent.post('/api/departments').send({ name: 'SITE A', parentId: qa }).expect(409);
    expect(res.body.code).toBe('department.nameTaken');
  });

  it('moves a department, never under itself or its own sub-department', async () => {
    const { agent, hse, hseSiteA, qa } = await company();
    const deeper = await department(agent, { name: 'Inspectors', parentId: hseSiteA });
    for (const parentId of [hse, deeper]) {
      const res = await agent.patch(`/api/departments/${hse}`).send({ parentId }).expect(400);
      expect(res.body.issues).toEqual([{ path: 'parentId', message: 'validation.departmentCycle' }]);
    }
    await agent.patch(`/api/departments/${hseSiteA}`).send({ parentId: qa }).expect(204);
    await agent.patch(`/api/departments/${hseSiteA}`).send({ parentId: null }).expect(204);
    const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'department.update' }, orderBy: { createdAt: 'desc' } });
    expect(log.data).toEqual({ changes: { parentId: { from: qa, to: null } } });
  });

  it('closes a department only when nothing is left in it', async () => {
    const { agent, site, hse, hseSiteA, qa } = await company();
    expect((await agent.patch(`/api/departments/${hse}`).send({ isActive: false }).expect(409)).body.code).toBe(
      'department.hasActiveChildren',
    );
    const team = (await agent.post('/api/teams').send({ siteId: site, name: 'Inspectors', departmentId: hseSiteA }).expect(201)).body.id;
    expect((await agent.patch(`/api/departments/${hseSiteA}`).send({ isActive: false }).expect(409)).body.code).toBe(
      'department.hasTeams',
    );
    await agent.patch(`/api/teams/${team}`).send({ isActive: false }).expect(204);
    await agent.patch(`/api/departments/${hseSiteA}`).send({ isActive: false }).expect(204);

    await hire(agent, { siteId: site, departmentId: qa }).expect(201);
    expect((await agent.patch(`/api/departments/${qa}`).send({ isActive: false }).expect(409)).body.code).toBe('department.hasWorkers');

    // Closed departments aren't chosen any more, and nothing opens under a closed one.
    expect((await hire(agent, { siteId: site, departmentId: hseSiteA }).expect(409)).body.code).toBe('department.inactive');
    await agent.patch(`/api/departments/${hse}`).send({ isActive: false }).expect(204);
    expect((await agent.patch(`/api/departments/${hseSiteA}`).send({ isActive: true }).expect(409)).body.code).toBe(
      'department.parentInactive',
    );
    expect((await agent.patch(`/api/teams/${team}`).send({ isActive: true }).expect(409)).body.code).toBe('department.inactive');
  });

  it('is switched on only with an active department, audited, and shown in "me"', async () => {
    const owner = await memberOfNewCompany(ctx, 'OWNER');
    const res = await owner.agent.put('/api/departments/settings').send({ enabled: true }).expect(409);
    expect(res.body.code).toBe('department.noneActive');
    await department(owner.agent, { name: 'HSE' });
    await turnOn(owner.agent);
    expect((await owner.agent.get('/api/auth/me').expect(200)).body.activeCompany.departments).toBe(true);
    await owner.agent.put('/api/departments/settings').send({ enabled: false }).expect(204);
    const log = await ctx.prisma.auditLog.findMany({ where: { action: 'company.departments' }, orderBy: { createdAt: 'asc' } });
    expect(log.map((l) => l.data)).toEqual([{ from: false, to: true }, { from: true, to: false }]);
  });
});

describe('placements and brigades', () => {
  it('needs a department for every new placement while departments are on', async () => {
    const { agent, site, hse } = await company();
    const before = (await hire(agent, { siteId: site }).expect(201)).body.id;
    await turnOn(agent);
    const res = await hire(agent, { siteId: site }).expect(400);
    expect(res.body.issues).toEqual([{ path: 'placement.departmentId', message: 'validation.required' }]);
    const worker = (await hire(agent, { siteId: site, departmentId: hse }).expect(201)).body.id;
    expect((await agent.get(`/api/workers/${worker}`).expect(200)).body.placement).toMatchObject({
      departmentId: hse,
      departmentName: 'HSE',
    });
    // A move is a new placement, with its own department.
    const move = await agent.post(`/api/workers/${worker}/placements`).send({ siteId: site, from: '2026-10-01' }).expect(400);
    expect(move.body.issues).toEqual([{ path: 'departmentId', message: 'validation.required' }]);
    // Workers from before stay as they were until filled in.
    expect((await agent.get(`/api/workers/${before}`).expect(200)).body.placement.departmentId).toBeNull();
  });

  it('gives a placement in a brigade the brigade\'s department, and refuses another one', async () => {
    const { agent, site, hseSiteA, qa } = await company();
    await turnOn(agent);
    const missing = await agent.post('/api/teams').send({ siteId: site, name: 'Inspectors' }).expect(400);
    expect(missing.body.issues).toEqual([{ path: 'departmentId', message: 'validation.required' }]);
    const team = (await agent.post('/api/teams').send({ siteId: site, name: 'Inspectors', departmentId: hseSiteA }).expect(201)).body.id;

    const worker = (await hire(agent, { siteId: site, teamId: team }).expect(201)).body.id;
    expect((await agent.get(`/api/workers/${worker}`).expect(200)).body.placement.departmentId).toBe(hseSiteA);
    const wrong = await hire(agent, { siteId: site, teamId: team, departmentId: qa }).expect(400);
    expect(wrong.body.issues).toEqual([{ path: 'placement.departmentId', message: 'validation.departmentNotTeams' }]);

    // The brigade's department is fixed once a placement has it: another department is a new brigade.
    expect((await agent.patch(`/api/teams/${team}`).send({ departmentId: qa }).expect(409)).body.code).toBe('team.departmentInUse');
    const sites = (await agent.get('/api/sites').expect(200)).body;
    expect(sites[0].teams[0]).toMatchObject({ departmentId: hseSiteA, departmentFixed: true });
    // The database keeps them equal too.
    await expect(
      ctx.prisma.assignment.updateMany({ where: { teamId: team }, data: { departmentId: qa } }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it("fills in departments from before: a brigade's for its placements, one by one without a brigade", async () => {
    const { agent, user, company: c, site, hse, qa } = await company();
    const team = (await agent.post('/api/teams').send({ siteId: site, name: 'Old brigade' }).expect(201)).body.id;
    const inTeam = (await hire(agent, { siteId: site, teamId: team }).expect(201)).body.id;
    const alone = (await hire(agent, { siteId: site }).expect(201)).body.id;
    await turnOn(agent);
    // A locked month doesn't stop it: pay doesn't depend on departments.
    await ctx.prisma.payrollPeriod.create({
      data: { companyId: c.id, year: 2026, month: 9, status: 'LOCKED', lockedAt: new Date(), lockedById: user.id },
    });

    const inTeamPlacement = (await agent.get(`/api/workers/${inTeam}`).expect(200)).body.placement.id;
    const direct = await agent.put(`/api/workers/${inTeam}/placements/${inTeamPlacement}/department`).send({ departmentId: hse }).expect(409);
    expect(direct.body.code).toBe('placement.departmentFromTeam');
    await agent.patch(`/api/teams/${team}`).send({ departmentId: hse }).expect(204);
    expect((await agent.get(`/api/workers/${inTeam}`).expect(200)).body.placement.departmentId).toBe(hse);
    expect((await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'team.update' } })).data).toMatchObject({
      departmentId: { from: null, to: hse },
      placementsFilled: 1,
    });

    const alonePlacement = (await agent.get(`/api/workers/${alone}`).expect(200)).body.placement.id;
    const url = `/api/workers/${alone}/placements/${alonePlacement}/department`;
    await agent.put(url).send({ departmentId: qa }).expect(204);
    expect((await agent.put(url).send({ departmentId: hse }).expect(409)).body.code).toBe('placement.hasDepartment');
    expect((await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'worker.placementDepartment' } })).data).toEqual({
      assignmentId: alonePlacement,
      departmentId: qa,
      departmentName: 'QA/QC',
    });
  });

  it('lets project managers create brigades in a department and place workers on their own sites only', async () => {
    const { company: c, agent, site, hse } = await company();
    const other = (await agent.post('/api/sites').send({ name: 'Site B' }).expect(201)).body.id;
    await turnOn(agent);
    const pm = await member(c.id, 'PROJECT_MANAGER');
    await agent.post(`/api/sites/${site}/staff`).send({ userId: pm.user.id }).expect(204);
    await pm.agent.post('/api/teams').send({ siteId: site, name: 'HSE brigade', departmentId: hse }).expect(201);
    await pm.agent.post('/api/teams').send({ siteId: other, name: 'HSE brigade', departmentId: hse }).expect(404);
    const worker = (await hire(agent, { siteId: other, departmentId: hse }).expect(201)).body.id;
    await pm.agent.get(`/api/workers/${worker}`).expect(404);
  });
});

describe('payroll by department', () => {
  it("counts each worker in their department of the month, the one of their last placement in it", async () => {
    const { agent, site, hse, hseSiteA, qa } = await company();
    await hire(agent, { siteId: site }).expect(201);
    await turnOn(agent);
    const mover = (await hire(agent, { siteId: site, departmentId: hse }).expect(201)).body.id;
    await agent.post(`/api/workers/${mover}/placements`).send({ siteId: site, departmentId: qa, from: '2026-09-16' }).expect(204);
    await hire(agent, { siteId: site, departmentId: hseSiteA }).expect(201);

    const month = (await agent.get('/api/payroll/2026/9').expect(200)).body;
    expect(month.workers.find((w: { worker: { id: string } }) => w.worker.id === mover).department).toEqual({ id: qa, name: 'QA/QC' });
    // HSE includes HSE Site A; nobody can be paid yet (no pay rules or salaries), so nothing adds up.
    const none = { withProblems: 1, total: '0.00', workers: 1 };
    expect(month.departments).toEqual(
      expect.arrayContaining([
        { departmentId: hse, ...none },
        { departmentId: hseSiteA, ...none },
        { departmentId: qa, ...none },
        { departmentId: null, ...none },
      ]),
    );
    expect(month.departments).toHaveLength(4);
  });

  it("adds a sub-department's pay to its parent's total", async () => {
    const { agent, site, hse, hseSiteA } = await company();
    await turnOn(agent);
    // September 2026: 25 working days of 9 hours (Sept 1 is a holiday, Sundays are rest days).
    await agent.put('/api/pay-rules/2026/9').send(RULES).expect(204);
    for (const [departmentId, salary] of [
      [hse, '7500000'],
      [hseSiteA, '5000000'],
    ]) {
      const worker = (await hire(agent, { siteId: site, departmentId }).expect(201)).body.id;
      await agent.post(`/api/workers/${worker}/salaries`).send({ fromYear: 2026, fromMonth: 9, monthlySalary: salary }).expect(201);
      const placement = (await agent.get(`/api/workers/${worker}`).expect(200)).body.placement.id;
      await agent.post(`/api/monthly-hours/2026/9/${placement}`).send(FULL_MONTH).expect(201);
    }
    const month = (await agent.get('/api/payroll/2026/9').expect(200)).body;
    expect(month.departments).toEqual([
      { departmentId: hse, workers: 2, withProblems: 0, total: '12500000.00' },
      { departmentId: hseSiteA, workers: 1, withProblems: 0, total: '5000000.00' },
    ]);
  });
});

describe('tenant isolation', () => {
  it("never shows, changes or uses another company's departments", async () => {
    const a = await company();
    const b = await company();
    expect((await b.agent.get('/api/departments').expect(200)).body.map((d: { id: string }) => d.id)).toEqual([b.hse, b.hseSiteA, b.qa]);
    await b.agent.patch(`/api/departments/${a.hse}`).send({ name: 'Mine' }).expect(404);
    await b.agent.patch(`/api/departments/${b.hse}`).send({ parentId: a.qa }).expect(404);
    await b.agent.post('/api/departments').send({ name: 'Under A', parentId: a.hse }).expect(404);
    await b.agent.post('/api/teams').send({ siteId: b.site, name: 'X', departmentId: a.hse }).expect(404);
    await hire(b.agent, { siteId: b.site, departmentId: a.hse }).expect(404);

    const worker = (await hire(b.agent, { siteId: b.site }).expect(201)).body.id;
    const placement = (await b.agent.get(`/api/workers/${worker}`).expect(200)).body.placement.id;
    await b.agent.put(`/api/workers/${worker}/placements/${placement}/department`).send({ departmentId: a.hse }).expect(404);
    await a.agent.put(`/api/workers/${worker}/placements/${placement}/department`).send({ departmentId: a.hse }).expect(404);
    expect(await ctx.prisma.department.findFirstOrThrow({ where: { id: a.hse } })).toMatchObject({ name: 'HSE', parentId: null });
  });
});
