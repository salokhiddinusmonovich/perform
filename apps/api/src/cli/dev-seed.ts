/**
 * Local development data: a platform admin, a demo company with one user per role,
 * and a second company (to see tenant isolation). Safe to re-run: it resets these
 * demo accounts and companies only.
 *
 *   npm run -w @puantaj/api seed:dev
 *
 * Refuses to run in production. All accounts use DEV_SEED_PASSWORD (apps/api/.env).
 */
import { PrismaClient, type Role } from '@prisma/client';
import { hashPassword } from '../auth/passwords';

const DEMO_DOMAIN = 'demo.puantaj.test';
const DEMO_PLAN = 'Demo plan';

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('dev-seed refuses to run in production.');
    process.exit(2);
  }
  const password = process.env.DEV_SEED_PASSWORD;
  if (!password || password.length < 10) {
    console.error('Set DEV_SEED_PASSWORD (10+ characters) in apps/api/.env first.');
    process.exit(2);
  }

  const prisma = new PrismaClient();
  try {
    const passwordHash = await hashPassword(password);

    await removeDemoData(prisma);

    const user = (local: string, fullName: string, extra: { isPlatformAdmin?: boolean; phone?: string } = {}) =>
      prisma.user.create({
        data: {
          email: `${local}@${DEMO_DOMAIN}`,
          phone: extra.phone ?? null,
          fullName,
          passwordHash,
          mustChangePassword: false,
          isPlatformAdmin: extra.isPlatformAdmin ?? false,
        },
      });

    await user('platform', 'Platform Admin', { isPlatformAdmin: true });

    const plan = await prisma.plan.create({
      data: { name: DEMO_PLAN, monthlyPrice: '1500000', maxActiveWorkers: 200, timesheetModule: true },
    });
    // Paid through next month.
    const now = new Date();
    const paidThrough = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const company = (name: string, slug: string) =>
      // On the plan for every month the demo data may cover.
      prisma.company.create({
        data: {
          name,
          slug,
          paidThrough,
          plans: { create: { planId: plan.id, fromMonth: new Date('2020-01-01') } },
          // Demo codes for the grid; a real company sets its own in Settings.
          timesheetCodes: {
            create: [
              { code: 'Y', status: 'ABSENT', inGrid: true },
              { code: 'T', status: 'LEAVE', inGrid: true },
              { code: 'B', status: 'SICK', inGrid: true },
              { code: 'S', status: 'TRAVEL', inGrid: true },
              { code: 'D', status: 'OFF' },
            ],
          },
        },
      });
    const demo = await company('Demo MEP', 'demo-mep');
    const other = await company('Other Construction', 'demo-other');

    const members: [string, string, Role, string?][] = [
      ['owner', 'Demo Owner', 'OWNER', '+998900000001'],
      ['admin', 'Demo Admin', 'ADMIN', '+998900000002'],
      ['accountant', 'Demo Accountant', 'ACCOUNTANT'],
      ['pm', 'Demo Project Manager', 'PROJECT_MANAGER'],
      ['timekeeper', 'Demo Timekeeper', 'TIMEKEEPER'],
      ['foreman', 'Demo Foreman', 'FOREMAN', '+998900000005'],
    ];
    const ids: Record<string, string> = {};
    for (const [local, name, role, phone] of members) {
      const u = await user(local, name, { phone });
      ids[local] = u.id;
      await prisma.membership.create({ data: { userId: u.id, companyId: demo.id, role, acceptedAt: new Date() } });
    }

    // Departments are on: Construction with an Electrical sub-department, and HSE and QA/QC without brigades.
    await prisma.company.update({ where: { id: demo.id }, data: { departmentsEnabled: true } });
    const construction = await prisma.department.create({ data: { companyId: demo.id, name: 'Construction' } });
    const electricalDept = await prisma.department.create({
      data: { companyId: demo.id, parentId: construction.id, name: 'Electrical', code: 'EL' },
    });
    const hse = await prisma.department.create({ data: { companyId: demo.id, name: 'HSE' } });
    await prisma.department.create({ data: { companyId: demo.id, name: 'QA/QC' } });
    // Two sites; the project manager and timekeeper work on the first, the foreman leads its team.
    const north = await prisma.site.create({ data: { companyId: demo.id, name: 'North Tower', code: 'NT' } });
    await prisma.site.create({ data: { companyId: demo.id, name: 'South Plant' } });
    const electrical = await prisma.team.create({
      data: { companyId: demo.id, siteId: north.id, name: 'Electrical 1', departmentId: electricalDept.id },
    });
    await prisma.memberSite.createMany({
      data: [ids.pm, ids.timekeeper].map((userId) => ({ userId, companyId: demo.id, siteId: north.id })),
    });
    await prisma.memberTeam.create({ data: { userId: ids.foreman, companyId: demo.id, teamId: electrical.id } });
    // Pay rules from September 2026, so the payroll pages have something to calculate.
    const ruleSet = await prisma.payrollRuleSet.create({ data: { companyId: demo.id } });
    await prisma.payrollRules.create({
      data: {
        companyId: demo.id,
        ruleSetId: ruleSet.id,
        fromYear: 2026,
        fromMonth: 9,
        restWeekdays: [7],
        normalHoursPerDay: '9',
        overtimeMultiplier: '1.5',
        restDayMultiplier: '2',
        holidayMultiplier: '2',
        leavePaid: true,
        sickPaid: true,
        sickHoursPerDay: '8',
        travelDayPaid: true,
        travelPayMode: 'NONE',
        payRoundingStep: '1000',
        setById: ids.owner,
      },
    });
    // Shifts are optional; one to give workers from the workers page.
    await prisma.shift.create({ data: { companyId: demo.id, name: 'Night', normalHoursPerDay: '10' } });
    // Two workers in the brigade: the first has a salary and September's hours, the second shows
    // how missing ones look. The HSE inspector has no brigade.
    for (const [lastName, firstName, position, monthlySalary, team] of [
      ['Demoev', 'Ali', 'Electrician', '6000000', true],
      ['Testova', 'Malika', 'Cable installer', null, true],
      ['Namunov', 'Sardor', 'HSE inspector', '5000000', false],
    ] as const) {
      const worker = await prisma.worker.create({ data: { companyId: demo.id, lastName, firstName, position } });
      const placement = await prisma.assignment.create({
        data: {
          companyId: demo.id,
          workerId: worker.id,
          siteId: north.id,
          teamId: team ? electrical.id : null,
          departmentId: team ? electricalDept.id : hse.id,
          hiredOn: new Date('2026-09-01'),
        },
      });
      if (monthlySalary) {
        await prisma.salary.create({
          data: { companyId: demo.id, workerId: worker.id, fromYear: 2026, fromMonth: 9, monthlySalary, setById: ids.accountant },
        });
        // September 2026: 25 working days; one sick day, 6 hours of overtime and a Sunday worked.
        await prisma.monthlyHours.create({
          data: {
            companyId: demo.id,
            assignmentId: placement.id,
            year: 2026,
            month: 9,
            fromDay: new Date('2026-09-01'),
            untilDay: new Date('2026-09-30'),
            normalHours: '216',
            overtimeHours: '6',
            restDayHours: '8',
            holidayHours: '0',
            workdaysWorked: 24,
            leaveDays: 0,
            sickDays: 1,
            travelDays: 0,
            setById: ids.accountant,
          },
        });
      }
    }
    const otherOwner = await user('other-owner', 'Other Owner');
    await prisma.membership.create({ data: { userId: otherOwner.id, companyId: other.id, role: 'OWNER', acceptedAt: new Date() } });
    // An open invitation, to see both sides: Demo MEP's users page and other-owner's dashboard.
    await prisma.membership.create({
      data: { userId: otherOwner.id, companyId: demo.id, role: 'FOREMAN', invitedName: 'Other Owner', invitedEmail: otherOwner.email },
    });

    console.log(`Demo data ready. Log in as <role>@${DEMO_DOMAIN} (platform, owner, admin, accountant, pm,`);
    console.log('timekeeper, foreman, other-owner) with DEV_SEED_PASSWORD from apps/api/.env.');
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Removes previous demo data (only demo accounts and demo companies). The schema never
 * cascades deletes, so everything that belongs to them is removed first, children first.
 */
async function removeDemoData(prisma: PrismaClient) {
  const userIds = (await prisma.user.findMany({ where: { email: { endsWith: `@${DEMO_DOMAIN}` } } })).map((u) => u.id);
  const companyIds = (await prisma.company.findMany({ where: { slug: { in: ['demo-mep', 'demo-other'] } } })).map(
    (c) => c.id,
  );
  const inCompany = { companyId: { in: companyIds } };
  await prisma.$transaction([
    prisma.auditLog.deleteMany({
      where: { OR: [inCompany, { actorUserId: { in: userIds } }, { impersonatorUserId: { in: userIds } }] },
    }),
    prisma.subscriptionPayment.deleteMany({ where: { OR: [inCompany, { recordedById: { in: userIds } }] } }),
    prisma.companyPlan.deleteMany({ where: { OR: [inCompany, { setById: { in: userIds } }] } }),
    prisma.adjustmentCancel.deleteMany({ where: inCompany }),
    prisma.adjustment.deleteMany({ where: inCompany }),
    prisma.travelAmount.deleteMany({ where: inCompany }),
    prisma.timesheetEntry.deleteMany({ where: inCompany }),
    prisma.payrollSnapshotWorker.deleteMany({ where: inCompany }),
    prisma.payrollSnapshot.deleteMany({ where: inCompany }),
    prisma.salary.deleteMany({ where: inCompany }),
    prisma.monthlyHours.deleteMany({ where: inCompany }),
    prisma.payrollPeriod.deleteMany({ where: inCompany }),
    prisma.workingDaysOverride.deleteMany({ where: inCompany }),
    prisma.payrollRules.deleteMany({ where: inCompany }),
    prisma.payrollRuleSet.deleteMany({ where: inCompany }),
    prisma.holiday.deleteMany({ where: inCompany }),
    prisma.timesheetCode.deleteMany({ where: inCompany }),
    prisma.assignment.deleteMany({ where: inCompany }),
    prisma.workerShift.deleteMany({ where: inCompany }),
    prisma.shift.deleteMany({ where: inCompany }),
    prisma.travelRoute.deleteMany({ where: inCompany }),
    prisma.memberSite.deleteMany({ where: { OR: [inCompany, { userId: { in: userIds } }] } }),
    prisma.memberTeam.deleteMany({ where: { OR: [inCompany, { userId: { in: userIds } }] } }),
    prisma.membership.deleteMany({ where: { OR: [inCompany, { userId: { in: userIds } }] } }),
    prisma.worker.deleteMany({ where: inCompany }),
    prisma.team.deleteMany({ where: inCompany }),
    prisma.department.deleteMany({ where: inCompany }),
    prisma.site.deleteMany({ where: inCompany }),
    prisma.session.deleteMany({ where: { userId: { in: userIds } } }),
    prisma.user.deleteMany({ where: { id: { in: userIds } } }),
    prisma.company.deleteMany({ where: { id: { in: companyIds } } }),
    prisma.plan.deleteMany({ where: { name: DEMO_PLAN } }),
  ]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
