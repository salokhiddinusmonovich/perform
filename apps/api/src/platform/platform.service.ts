import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CreateCompany } from '@puantaj/schemas';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth.context';
import { notFound } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { UserAccountsService } from '../users/user-accounts.service';

export interface CompanyListItem {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  isActive: boolean;
  createdAt: Date;
  memberCount: number;
  owners: { fullName: string; email: string | null; phone: string | null }[];
}

/** Customer companies, managed by platform admins (the product operator). */
@Injectable()
export class PlatformService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: UserAccountsService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<CompanyListItem[]> {
    const companies = await this.prisma.company.findMany({
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { memberships: { where: { isActive: true } } } },
        memberships: { where: { role: 'OWNER', isActive: true }, include: { user: true } },
      },
    });
    return companies.map((c) => ({
      id: c.id,
      name: c.name,
      currency: c.currency,
      timezone: c.timezone,
      isActive: c.isActive,
      createdAt: c.createdAt,
      memberCount: c._count.memberships,
      owners: c.memberships.map((m) => ({ fullName: m.user.fullName, email: m.user.email, phone: m.user.phone })),
    }));
  }

  /** Creates a company and makes the given person its owner (new account if needed). */
  async create(auth: AuthContext, input: CreateCompany) {
    return this.prisma.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: {
          name: input.name,
          currency: input.currency,
          timezone: input.timezone,
          slug: await uniqueSlug(tx, input.name),
        },
      });
      const { user, temporaryPassword } = await this.accounts.findOrCreate(tx, input.owner);
      await tx.membership.create({ data: { userId: user.id, companyId: company.id, role: 'OWNER' } });
      await this.audit.record(
        {
          action: 'company.create',
          companyId: company.id,
          actorUserId: auth.user.id,
          entityType: 'Company',
          entityId: company.id,
          data: { name: company.name, ownerUserId: user.id, newOwnerAccount: temporaryPassword !== undefined },
          ip: auth.ip,
        },
        tx,
      );
      return { companyId: company.id, ownerUserId: user.id, temporaryPassword: temporaryPassword ?? null };
    });
  }

  async setActive(auth: AuthContext, companyId: string, isActive: boolean) {
    await this.prisma.$transaction(async (tx) => {
      const company = await tx.company.findUnique({ where: { id: companyId } });
      if (!company) throw notFound('company.notFound');
      await tx.company.update({ where: { id: companyId }, data: { isActive } });
      await this.audit.record(
        {
          action: isActive ? 'company.activate' : 'company.deactivate',
          companyId,
          actorUserId: auth.user.id,
          entityType: 'Company',
          entityId: companyId,
          ip: auth.ip,
        },
        tx,
      );
    });
  }
}

/** URL-safe identifier from the name, e.g. "Perform MEP" → "perform-mep" (suffix if taken). */
async function uniqueSlug(tx: Prisma.TransactionClient, name: string) {
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'company';
  let slug = base;
  while (await tx.company.findUnique({ where: { slug } })) {
    slug = `${base}-${randomBytes(2).toString('hex')}`;
  }
  return slug;
}
