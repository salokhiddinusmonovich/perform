import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { DEFAULT_ENTRY_ROLES, type EntryRole, type TimesheetSettings } from '@puantaj/schemas';
import { AuditService } from '../audit/audit.service';
import type { CompanyAuthContext } from '../auth/auth.context';
import { PrismaService } from '../prisma/prisma.service';

export interface TimesheetSettingsView {
  entryRoles: EntryRole[];
  /** null while the company still has the defaults */
  setBy: { fullName: string } | null;
  setAt: Date | null;
}

type Db = Prisma.TransactionClient | PrismaService;

/** Who enters daily hours (AGENTS.md: Hour entry). Owners and admins change it. */
@Injectable()
export class TimesheetSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Roles the company lets enter hours, besides owners and admins. */
  async entryRoles(companyId: string, db: Db = this.prisma): Promise<EntryRole[]> {
    const row = await db.timesheetSettings.findUnique({ where: { companyId } });
    return row ? (row.entryRoles as EntryRole[]) : [...DEFAULT_ENTRY_ROLES];
  }

  async get(auth: CompanyAuthContext): Promise<TimesheetSettingsView> {
    const row = await this.prisma.timesheetSettings.findUnique({
      where: { companyId: auth.company.id },
      include: { setBy: { select: { fullName: true } } },
    });
    if (!row) return { entryRoles: [...DEFAULT_ENTRY_ROLES], setBy: null, setAt: null };
    return { entryRoles: row.entryRoles as EntryRole[], setBy: row.setBy, setAt: row.setAt };
  }

  async set(auth: CompanyAuthContext, input: TimesheetSettings): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const before = await this.entryRoles(companyId, tx);
      const fields = { entryRoles: input.entryRoles, setById: auth.user.id, setAt: new Date() };
      await tx.timesheetSettings.upsert({ where: { companyId }, create: { companyId, ...fields }, update: fields });
      await this.audit.record(
        {
          action: 'timesheetSettings.set',
          companyId,
          auth,
          entityType: 'Company',
          entityId: companyId,
          data: { entryRoles: { from: before, to: input.entryRoles } },
        },
        tx,
      );
    });
  }
}
