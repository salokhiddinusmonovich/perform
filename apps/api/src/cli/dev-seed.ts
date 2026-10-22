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

    const demo = await prisma.company.create({ data: { name: 'Demo MEP', slug: 'demo-mep' } });
    const other = await prisma.company.create({ data: { name: 'Other Construction', slug: 'demo-other' } });

    const members: [string, string, Role, string?][] = [
      ['owner', 'Demo Owner', 'OWNER', '+998900000001'],
      ['admin', 'Demo Admin', 'ADMIN', '+998900000002'],
      ['accountant', 'Demo Accountant', 'ACCOUNTANT'],
      ['timekeeper', 'Demo Timekeeper', 'TIMEKEEPER'],
      ['foreman', 'Demo Foreman', 'FOREMAN', '+998900000005'],
    ];
    for (const [local, name, role, phone] of members) {
      const u = await user(local, name, { phone });
      await prisma.membership.create({ data: { userId: u.id, companyId: demo.id, role, acceptedAt: new Date() } });
    }
    const otherOwner = await user('other-owner', 'Other Owner');
    await prisma.membership.create({ data: { userId: otherOwner.id, companyId: other.id, role: 'OWNER', acceptedAt: new Date() } });
    // An open invitation, to see both sides: Demo MEP's users page and other-owner's dashboard.
    await prisma.membership.create({
      data: { userId: otherOwner.id, companyId: demo.id, role: 'FOREMAN', invitedName: 'Other Owner', invitedEmail: otherOwner.email },
    });

    console.log(`Demo data ready. Log in as <role>@${DEMO_DOMAIN} (platform, owner, admin, accountant,`);
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
    prisma.auditLog.deleteMany({ where: { OR: [inCompany, { actorUserId: { in: userIds } }] } }),
    prisma.adjustment.deleteMany({ where: inCompany }),
    prisma.timesheetEntry.deleteMany({ where: inCompany }),
    prisma.payrollPeriod.deleteMany({ where: inCompany }),
    prisma.workingDaysOverride.deleteMany({ where: inCompany }),
    prisma.payrollRules.deleteMany({ where: inCompany }),
    prisma.payrollRuleSet.deleteMany({ where: inCompany }),
    prisma.holiday.deleteMany({ where: inCompany }),
    prisma.timesheetCode.deleteMany({ where: inCompany }),
    prisma.assignment.deleteMany({ where: inCompany }),
    prisma.travelRoute.deleteMany({ where: inCompany }),
    prisma.membership.deleteMany({ where: { OR: [inCompany, { userId: { in: userIds } }] } }),
    prisma.worker.deleteMany({ where: inCompany }),
    prisma.team.deleteMany({ where: inCompany }),
    prisma.site.deleteMany({ where: inCompany }),
    prisma.session.deleteMany({ where: { userId: { in: userIds } } }),
    prisma.user.deleteMany({ where: { id: { in: userIds } } }),
    prisma.company.deleteMany({ where: { id: { in: companyIds } } }),
  ]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
