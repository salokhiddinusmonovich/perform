import { Injectable } from '@nestjs/common';
import type { Prisma, User } from '@prisma/client';
import type { Contact } from '@puantaj/schemas';
import { conflict } from '../common/api-error';
import { generateTemporaryPassword, hashPassword } from '../auth/passwords';

export interface AccountResult {
  user: User;
  /** Only when a new account was created: shown once to the admin, never stored. */
  temporaryPassword?: string;
}

/** Shared by platform (company owners) and company admins (members). */
@Injectable()
export class UserAccountsService {
  /**
   * Returns the person's existing account (matched by email or phone), or creates one
   * with a temporary password. An existing account's details are never changed here:
   * another company's admin must not be able to edit someone's login.
   */
  async findOrCreate(tx: Prisma.TransactionClient, contact: Contact): Promise<AccountResult> {
    const [byEmail, byPhone] = await Promise.all([
      contact.email ? tx.user.findUnique({ where: { email: contact.email } }) : null,
      contact.phone ? tx.user.findUnique({ where: { phone: contact.phone } }) : null,
    ]);
    if (byEmail && byPhone && byEmail.id !== byPhone.id) throw conflict('user.contactsBelongToDifferentPeople');
    const existing = byEmail ?? byPhone;
    if (existing) return { user: existing };

    const temporaryPassword = generateTemporaryPassword();
    const user = await tx.user.create({
      data: {
        fullName: contact.fullName,
        email: contact.email ?? null,
        phone: contact.phone ?? null,
        passwordHash: await hashPassword(temporaryPassword),
        mustChangePassword: true,
      },
    });
    return { user, temporaryPassword };
  }
}
