/**
 * Creates the first platform admin (or promotes an existing user). Run on the server:
 *
 *   docker compose exec api node dist/cli/create-platform-admin.js --name "Full Name" --phone "+998901234567"
 *   (or --email you@example.com)
 *
 * Prints a temporary password for a new account; it must be changed at first login.
 * The password is shown only in this terminal and never stored or logged.
 */
import { PrismaClient } from '@prisma/client';
import { contactSchema } from '@puantaj/schemas';
import { parseArgs } from 'node:util';
import { generateTemporaryPassword, hashPassword } from '../auth/passwords';

async function main() {
  const { values } = parseArgs({
    options: { name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' } },
  });
  const parsed = contactSchema.safeParse({ fullName: values.name, email: values.email, phone: values.phone });
  if (!parsed.success) {
    console.error('Invalid input:', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '));
    console.error('Usage: create-platform-admin --name "Full Name" (--phone +998... | --email you@example.com)');
    process.exit(2);
  }
  const contact = parsed.data;

  const prisma = new PrismaClient();
  try {
    const [byEmail, byPhone] = await Promise.all([
      contact.email ? prisma.user.findUnique({ where: { email: contact.email } }) : null,
      contact.phone ? prisma.user.findUnique({ where: { phone: contact.phone } }) : null,
    ]);
    if (byEmail && byPhone && byEmail.id !== byPhone.id) {
      console.error('That email and that phone belong to two different existing users. Use only one of them.');
      process.exit(2);
    }
    const existing = byEmail ?? byPhone;
    if (existing) {
      await prisma.user.update({ where: { id: existing.id }, data: { isPlatformAdmin: true } });
      await prisma.auditLog.create({
        data: { action: 'platform.adminGranted', entityType: 'User', entityId: existing.id, data: { via: 'cli' } },
      });
      console.log(`Existing user "${existing.fullName}" is now a platform admin. Their password is unchanged.`);
      return;
    }

    const temporaryPassword = generateTemporaryPassword();
    const user = await prisma.user.create({
      data: {
        fullName: contact.fullName,
        email: contact.email ?? null,
        phone: contact.phone ?? null,
        passwordHash: await hashPassword(temporaryPassword),
        mustChangePassword: true,
        isPlatformAdmin: true,
      },
    });
    await prisma.auditLog.create({
      data: { action: 'platform.adminCreated', entityType: 'User', entityId: user.id, data: { via: 'cli' } },
    });
    console.log(`Platform admin created: ${user.fullName} (${user.email ?? user.phone})`);
    console.log(`Temporary password: ${temporaryPassword}`);
    console.log('Log in with it; you will be asked to choose a new password.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
