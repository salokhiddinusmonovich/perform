import { Injectable } from '@nestjs/common';
import { normalizeCode } from '@puantaj/payroll';
import { CODE_STATUSES, type CodeStatus, type TimesheetCodes } from '@puantaj/schemas';
import { AuditService } from '../audit/audit.service';
import type { CompanyAuthContext } from '../auth/auth.context';
import { badRequest } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';

export interface TimesheetCodeView {
  code: string;
  status: CodeStatus;
  /** The code the grid shows for its status */
  inGrid: boolean;
}

/**
 * A company's own codes (AGENTS.md: The daily grid): typed in the grid and read by Excel
 * imports, the same letters in every language. Owners and admins change the list.
 */
@Injectable()
export class TimesheetCodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Ordered by status (as in CODE_STATUSES), then by code. */
  async list(companyId: string): Promise<TimesheetCodeView[]> {
    const rows = await this.prisma.timesheetCode.findMany({ where: { companyId } });
    return rows
      .map((r) => ({ code: r.code, status: r.status as CodeStatus, inGrid: r.inGrid }))
      .sort((a, b) => CODE_STATUSES.indexOf(a.status) - CODE_STATUSES.indexOf(b.status) || a.code.localeCompare(b.code));
  }

  /** Replaces the whole list. Entries keep their statuses, so a changed code changes no hours. */
  async set(auth: CompanyAuthContext, input: TimesheetCodes): Promise<void> {
    const companyId = auth.company.id;
    const codes = input.codes.map((c) => ({ ...c, code: normalizeCode(c.code) }));
    // The same code twice once normalized (e.g. "iz" and "IZ"): reported on the later one.
    const issues = codes.flatMap((c, i) =>
      codes.findIndex((other) => other.code === c.code) < i ? [{ path: `codes.${i}.code`, message: 'validation.codeTaken' }] : [],
    );
    if (issues.length > 0) throw badRequest('validation', { issues });

    await this.prisma.$transaction(async (tx) => {
      const before = await tx.timesheetCode.findMany({ where: { companyId }, orderBy: { code: 'asc' } });
      await tx.timesheetCode.deleteMany({ where: { companyId } });
      await tx.timesheetCode.createMany({ data: codes.map((c) => ({ companyId, ...c })) });
      await this.audit.record(
        {
          action: 'timesheetCodes.set',
          companyId,
          auth,
          entityType: 'Company',
          entityId: companyId,
          data: {
            from: before.map(({ code, status, inGrid }) => ({ code, status, inGrid })),
            to: codes,
          },
        },
        tx,
      );
    });
  }
}
