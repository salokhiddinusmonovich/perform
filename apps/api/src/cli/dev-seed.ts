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

    // Remove previous demo data (only demo accounts and demo companies).
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${DEMO_DOMAIN}` } } });
    await prisma.company.deleteMany({ where: { slug: { in: ['demo-mep', 'demo-other'] } } });

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
      await prisma.membership.create({ data: { userId: u.id, companyId: demo.id, role } });
    }
    const otherOwner = await user('other-owner', 'Other Owner');
    await prisma.membership.create({ data: { userId: otherOwner.id, companyId: other.id, role: 'OWNER' } });

    console.log(`Demo data ready. Log in as <role>@${DEMO_DOMAIN} (platform, owner, admin, accountant,`);
    console.log('timekeeper, foreman, other-owner) with DEV_SEED_PASSWORD from apps/api/.env.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
