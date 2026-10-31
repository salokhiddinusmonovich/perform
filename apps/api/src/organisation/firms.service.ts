import { Injectable } from '@nestjs/common';
import type { FirmType, Prisma } from '@prisma/client';
import type { Firm, UpdateFirm } from '@puantaj/schemas';
import { AuditService } from '../audit/audit.service';
import type { CompanyAuthContext } from '../auth/auth.context';
import { conflict, notFound } from '../common/api-error';
import { notEndedBefore, todayIn } from '../common/dates';
import { PrismaService } from '../prisma/prisma.service';

export interface FirmView {
  id: string;
  name: string;
  type: FirmType;
  isActive: boolean;
}

type Tx = Prisma.TransactionClient;

/**
 * Firms (AGENTS.md: Firms): the company's own legal entities and its subcontractors.
 * Everyone sees them (they carry no pay); owners and admins create, rename and (de)activate
 * them, and switch firms on or off for the company. Placements, salaries, adjustments and
 * rule sets point to them.
 */
@Injectable()
export class FirmsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(auth: CompanyAuthContext): Promise<FirmView[]> {
    const rows = await this.prisma.firm.findMany({ where: { companyId: auth.company.id }, orderBy: { name: 'asc' } });
    return rows.map(view);
  }

  async create(auth: CompanyAuthContext, input: Firm): Promise<{ id: string }> {
    const companyId = auth.company.id;
    return this.prisma.$transaction(async (tx) => {
      await this.assertNameFree(tx, companyId, input.name, null);
      const row = await tx.firm.create({ data: { companyId, ...input } });
      await this.record(tx, auth, 'firm.create', row.id, { ...input });
      return { id: row.id };
    });
  }

  async update(auth: CompanyAuthContext, id: string, input: UpdateFirm): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.firm.findFirst({ where: { id, companyId } });
      if (!before) throw notFound('firm.notFound');
      if (input.name !== undefined && input.name.toLowerCase() !== before.name.toLowerCase()) {
        await this.assertNameFree(tx, companyId, input.name, id);
      }
      if (input.isActive === false && before.isActive) await this.assertUnused(tx, auth, id);

      await tx.firm.update({ where: { id }, data: input });
      const old = { name: before.name, type: before.type, isActive: before.isActive };
      const changed = (Object.keys(input) as (keyof UpdateFirm)[]).filter(
        (k) => input[k] !== undefined && input[k] !== old[k],
      );
      await this.record(tx, auth, 'firm.update', id, {
        changes: Object.fromEntries(changed.map((k) => [k, { from: old[k], to: input[k] ?? null }])),
      });
    });
  }

  /** Switches firms on or off for the company. On needs an active firm to choose. */
  async setEnabled(auth: CompanyAuthContext, enabled: boolean): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.company.findUniqueOrThrow({ where: { id: companyId } });
      if (before.firmsEnabled === enabled) return;
      if (enabled && (await tx.firm.count({ where: { companyId, isActive: true } })) === 0) {
        throw conflict('firm.noneActive');
      }
      await tx.company.update({ where: { id: companyId }, data: { firmsEnabled: enabled } });
      await this.audit.record(
        {
          action: 'company.firms',
          companyId,
          auth,
          entityType: 'Company',
          entityId: companyId,
          data: { from: before.firmsEnabled, to: enabled },
        },
        tx,
      );
    });
  }

  /** A firm is closed only when no placement not ended before today has it (one starting later counts too). */
  private async assertUnused(tx: Tx, auth: CompanyAuthContext, id: string) {
    const today = todayIn(auth.company.timezone);
    if (await tx.assignment.count({ where: { firmId: id, ...notEndedBefore(today) } })) {
      throw conflict('firm.hasWorkers');
    }
  }

  /** Names are unique in the company, ignoring case (also a unique index). */
  private async assertNameFree(tx: Tx, companyId: string, name: string, exceptId: string | null) {
    const other = await tx.firm.findFirst({
      where: { companyId, name: { equals: name, mode: 'insensitive' }, NOT: exceptId ? { id: exceptId } : undefined },
    });
    if (other) throw conflict('firm.nameTaken');
  }

  private record(tx: Tx, auth: CompanyAuthContext, action: string, id: string, data: Prisma.InputJsonObject) {
    return this.audit.record({ action, companyId: auth.company.id, auth, entityType: 'Firm', entityId: id, data }, tx);
  }
}

/** A firm of the company that can be chosen now: active, unless it is `current`, the one already there. */
export async function findFirm(db: Tx | PrismaService, companyId: string, id: string, current: string | null = null) {
  const firm = await db.firm.findFirst({ where: { id, companyId } });
  if (!firm) throw notFound('firm.notFound');
  if (!firm.isActive && id !== current) throw conflict('firm.inactive');
  return firm;
}

function view(f: { id: string; name: string; type: FirmType; isActive: boolean }): FirmView {
  return { id: f.id, name: f.name, type: f.type, isActive: f.isActive };
}
