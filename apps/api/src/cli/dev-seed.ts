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
    const paidUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const company = (name: string, slug: string) =>
      prisma.company.create({ data: { name, slug, planId: plan.id, paidUntil } });
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

    // Two sites; the project manager and timekeeper work on the first, the foreman leads its team.
    const north = await prisma.site.create({ data: { companyId: demo.id, name: 'North Tower', code: 'NT' } });
    await prisma.site.create({ data: { companyId: demo.id, name: 'South Plant' } });
    const electrical = await prisma.team.create({
      data: { companyId: demo.id, siteId: north.id, name: 'Electrical 1', department: 'Electrical' },
    });
    await prisma.memberSite.createMany({
      data: [ids.pm, ids.timekeeper].map((userId) => ({ userId, companyId: demo.id, siteId: north.id })),
    });
    await prisma.memberTeam.create({ data: { userId: ids.foreman, companyId: demo.id, teamId: electrical.id } });
    for (const [lastName, firstName, position] of [
      ['Demoev', 'Ali', 'Electrician'],
      ['Testova', 'Malika', 'Cable installer'],
    ]) {
      const worker = await prisma.worker.create({ data: { companyId: demo.id, lastName, firstName, position } });
      await prisma.assignment.create({
        data: { companyId: demo.id, workerId: worker.id, siteId: north.id, teamId: electrical.id, hiredOn: new Date('2026-09-01') },
      });
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
    prisma.adjustment.deleteMany({ where: inCompany }),
    prisma.timesheetEntry.deleteMany({ where: inCompany }),
    prisma.salary.deleteMany({ where: inCompany }),
    prisma.payrollPeriod.deleteMany({ where: inCompany }),
    prisma.workingDaysOverride.deleteMany({ where: inCompany }),
    prisma.payrollRules.deleteMany({ where: inCompany }),
    prisma.payrollRuleSet.deleteMany({ where: inCompany }),
    prisma.holiday.deleteMany({ where: inCompany }),
    prisma.timesheetCode.deleteMany({ where: inCompany }),
    prisma.assignment.deleteMany({ where: inCompany }),
    prisma.travelRoute.deleteMany({ where: inCompany }),
    prisma.memberSite.deleteMany({ where: { OR: [inCompany, { userId: { in: userIds } }] } }),
    prisma.memberTeam.deleteMany({ where: { OR: [inCompany, { userId: { in: userIds } }] } }),
    prisma.membership.deleteMany({ where: { OR: [inCompany, { userId: { in: userIds } }] } }),
    prisma.worker.deleteMany({ where: inCompany }),
    prisma.team.deleteMany({ where: inCompany }),
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
