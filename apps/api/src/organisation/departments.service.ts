import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Department, UpdateDepartment } from '@puantaj/schemas';
import { AuditService } from '../audit/audit.service';
import type { CompanyAuthContext } from '../auth/auth.context';
import { badRequest, conflict, notFound } from '../common/api-error';
import { notEndedBefore, todayIn } from '../common/dates';
import { PrismaService } from '../prisma/prisma.service';

export interface DepartmentView {
  id: string;
  /** The department it sits under; null: top level */
  parentId: string | null;
  name: string;
  code: string | null;
  isActive: boolean;
}

type Tx = Prisma.TransactionClient;

/**
 * Departments (AGENTS.md: Departments): the company's own tree, company-wide. Everyone
 * sees them (they carry no pay); owners and admins create, rename, move and (de)activate
 * them, and switch departments on or off for the company. Brigades and placements point to
 * them (sites.service, workers.service).
 */
@Injectable()
export class DepartmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(auth: CompanyAuthContext): Promise<DepartmentView[]> {
    const rows = await this.prisma.department.findMany({ where: { companyId: auth.company.id }, orderBy: { name: 'asc' } });
    return rows.map(view);
  }

  async create(auth: CompanyAuthContext, input: Department): Promise<{ id: string }> {
    const companyId = auth.company.id;
    return this.prisma.$transaction(async (tx) => {
      if (input.parentId) await findDepartment(tx, companyId, input.parentId);
      await this.assertNameFree(tx, companyId, input.parentId, input.name, null);
      const row = await tx.department.create({ data: { companyId, ...input } });
      await this.record(tx, auth, 'department.create', row.id, { ...input });
      return { id: row.id };
    });
  }

  async update(auth: CompanyAuthContext, id: string, input: UpdateDepartment): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.department.findFirst({ where: { id, companyId } });
      if (!before) throw notFound('department.notFound');
      const parentId = input.parentId === undefined ? before.parentId : input.parentId;

      if (parentId !== before.parentId && parentId !== null) {
        const all = await tx.department.findMany({ where: { companyId }, select: { id: true, parentId: true } });
        if (!all.some((d) => d.id === parentId)) throw notFound('department.notFound');
        // Under itself or one of its own sub-departments would make a cycle.
        if (subtreeIds(all, id).has(parentId)) {
          throw badRequest('validation', { issues: [{ path: 'parentId', message: 'validation.departmentCycle' }] });
        }
        await findDepartment(tx, companyId, parentId);
      }
      const name = input.name ?? before.name;
      if (parentId !== before.parentId || name.toLowerCase() !== before.name.toLowerCase()) {
        await this.assertNameFree(tx, companyId, parentId, name, id);
      }

      const isActive = input.isActive ?? before.isActive;
      if (!isActive && before.isActive) await this.assertUnused(tx, auth, id);
      if (isActive && parentId) {
        const parent = await tx.department.findFirstOrThrow({ where: { id: parentId, companyId } });
        if (!parent.isActive) throw conflict('department.parentInactive');
      }

      await tx.department.update({ where: { id }, data: input });
      const old = { name: before.name, code: before.code, parentId: before.parentId, isActive: before.isActive };
      const changed = (Object.keys(input) as (keyof UpdateDepartment)[]).filter(
        (k) => input[k] !== undefined && input[k] !== old[k],
      );
      await this.record(tx, auth, 'department.update', id, {
        changes: Object.fromEntries(changed.map((k) => [k, { from: old[k], to: input[k] ?? null }])),
      });
    });
  }

  /** Switches departments on or off for the company. On needs an active department to choose. */
  async setEnabled(auth: CompanyAuthContext, enabled: boolean): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.company.findUniqueOrThrow({ where: { id: companyId } });
      if (before.departmentsEnabled === enabled) return;
      if (enabled && (await tx.department.count({ where: { companyId, isActive: true } })) === 0) {
        throw conflict('department.noneActive');
      }
      await tx.company.update({ where: { id: companyId }, data: { departmentsEnabled: enabled } });
      await this.audit.record(
        {
          action: 'company.departments',
          companyId,
          auth,
          entityType: 'Company',
          entityId: companyId,
          data: { from: before.departmentsEnabled, to: enabled },
        },
        tx,
      );
    });
  }

  /**
   * A department is closed only when nothing would be left in it: no active sub-department,
   * no active brigade, and no placement not ended before today (one starting later counts too).
   */
  private async assertUnused(tx: Tx, auth: CompanyAuthContext, id: string) {
    if (await tx.department.count({ where: { parentId: id, isActive: true } })) throw conflict('department.hasActiveChildren');
    if (await tx.team.count({ where: { departmentId: id, isActive: true } })) throw conflict('department.hasTeams');
    const today = todayIn(auth.company.timezone);
    if (await tx.assignment.count({ where: { departmentId: id, ...notEndedBefore(today) } })) {
      throw conflict('department.hasWorkers');
    }
  }

  /** Names are unique among siblings, ignoring case (also a unique index). */
  private async assertNameFree(tx: Tx, companyId: string, parentId: string | null, name: string, exceptId: string | null) {
    const other = await tx.department.findFirst({
      where: { companyId, parentId, name: { equals: name, mode: 'insensitive' }, NOT: exceptId ? { id: exceptId } : undefined },
    });
    if (other) throw conflict('department.nameTaken');
  }

  private record(tx: Tx, auth: CompanyAuthContext, action: string, id: string, data: Prisma.InputJsonObject) {
    return this.audit.record(
      { action, companyId: auth.company.id, auth, entityType: 'Department', entityId: id, data },
      tx,
    );
  }
}

/**
 * A department of the company that can be chosen now: active, unless it is `current`, the
 * one already there.
 */
export async function findDepartment(tx: Tx, companyId: string, id: string, current: string | null = null) {
  const department = await tx.department.findFirst({ where: { id, companyId } });
  if (!department) throw notFound('department.notFound');
  if (!department.isActive && id !== current) throw conflict('department.inactive');
  return department;
}

/** A department and everything under it, at any depth. */
export function subtreeIds(all: readonly { id: string; parentId: string | null }[], rootId: string): Set<string> {
  const ids = new Set([rootId]);
  for (let added = true; added; ) {
    added = false;
    for (const d of all) {
      if (d.parentId && ids.has(d.parentId) && !ids.has(d.id)) {
        ids.add(d.id);
        added = true;
      }
    }
  }
  return ids;
}

function view(d: { id: string; parentId: string | null; name: string; code: string | null; isActive: boolean }): DepartmentView {
  return { id: d.id, parentId: d.parentId, name: d.name, code: d.code, isActive: d.isActive };
}
