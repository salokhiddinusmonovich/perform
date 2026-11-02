import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CategoryOption, UpdateCategoryOption, UpdateWorkerCategory, WorkerCategory } from '@puantaj/schemas';
import { AuditService } from '../audit/audit.service';
import type { CompanyAuthContext } from '../auth/auth.context';
import { badRequest, conflict, notFound } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';

export interface CategoryOptionView {
  id: string;
  name: string;
  isActive: boolean;
}

export interface WorkerCategoryView {
  id: string;
  name: string;
  isActive: boolean;
  /** In the order they were added */
  options: CategoryOptionView[];
}

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;


/**
 * Worker categories (AGENTS.md: Worker categories): the company's own ways of grouping
 * workers, each with its options. Everyone sees them (they carry no pay); owners and admins
 * create, rename and (de)activate them. They never change pay.
 */
@Injectable()
export class WorkerCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(auth: CompanyAuthContext): Promise<WorkerCategoryView[]> {
    return listCategories(this.prisma, auth.company.id);
  }

  async create(auth: CompanyAuthContext, input: WorkerCategory): Promise<{ id: string }> {
    const companyId = auth.company.id;
    return this.prisma.$transaction(async (tx) => {
      await this.assertNameFree(tx, companyId, input.name, null);
      const row = await tx.workerCategory.create({ data: { companyId, name: input.name } });
      await tx.workerCategoryOption.createMany({
        data: input.options.map((name, position) => ({ companyId, categoryId: row.id, position, name })),
      });
      await this.record(tx, auth, 'workerCategory.create', row.id, { ...input });
      return { id: row.id };
    });
  }

  async update(auth: CompanyAuthContext, id: string, input: UpdateWorkerCategory): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const before = await this.find(tx, companyId, id);
      if (input.name !== undefined && input.name.toLowerCase() !== before.name.toLowerCase()) {
        await this.assertNameFree(tx, companyId, input.name, id);
      }
      await tx.workerCategory.update({ where: { id }, data: input });
      await this.record(tx, auth, 'workerCategory.update', id, { changes: changesOf(before, input) });
    });
  }

  async addOption(auth: CompanyAuthContext, id: string, input: CategoryOption): Promise<{ id: string }> {
    const companyId = auth.company.id;
    return this.prisma.$transaction(async (tx) => {
      await this.find(tx, companyId, id);
      await this.assertOptionFree(tx, id, input.name, null);
      // Last in the list; the unique (category, position) refuses a second option added at the same time.
      const last = await tx.workerCategoryOption.aggregate({ where: { categoryId: id }, _max: { position: true } });
      const position = (last._max.position ?? -1) + 1;
      const row = await tx.workerCategoryOption.create({ data: { companyId, categoryId: id, position, name: input.name } });
      await this.record(tx, auth, 'workerCategory.addOption', id, { optionId: row.id, name: input.name });
      return { id: row.id };
    });
  }

  async updateOption(auth: CompanyAuthContext, id: string, optionId: string, input: UpdateCategoryOption): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      await this.find(tx, companyId, id);
      const before = await tx.workerCategoryOption.findFirst({ where: { id: optionId, categoryId: id, companyId } });
      if (!before) throw notFound('workerCategory.optionNotFound');
      if (input.name !== undefined && input.name.toLowerCase() !== before.name.toLowerCase()) {
        await this.assertOptionFree(tx, id, input.name, optionId);
      }
      await tx.workerCategoryOption.update({ where: { id: optionId }, data: input });
      await this.record(tx, auth, 'workerCategory.updateOption', id, { optionId, changes: changesOf(before, input) });
    });
  }

  private async find(tx: Tx, companyId: string, id: string) {
    const row = await tx.workerCategory.findFirst({ where: { id, companyId } });
    if (!row) throw notFound('workerCategory.notFound');
    return row;
  }

  /** Category names are unique in the company, ignoring case. */
  private async assertNameFree(tx: Tx, companyId: string, name: string, exceptId: string | null) {
    const other = await tx.workerCategory.findFirst({
      where: { companyId, name: { equals: name, mode: 'insensitive' }, NOT: exceptId ? { id: exceptId } : undefined },
    });
    if (other) throw conflict('workerCategory.nameTaken');
  }

  /** Option names are unique in their category, ignoring case. */
  private async assertOptionFree(tx: Tx, categoryId: string, name: string, exceptId: string | null) {
    const other = await tx.workerCategoryOption.findFirst({
      where: { categoryId, name: { equals: name, mode: 'insensitive' }, NOT: exceptId ? { id: exceptId } : undefined },
    });
    if (other) throw conflict('workerCategory.optionTaken');
  }

  private record(tx: Tx, auth: CompanyAuthContext, action: string, id: string, data: Prisma.InputJsonObject) {
    return this.audit.record(
      { action, companyId: auth.company.id, auth, entityType: 'WorkerCategory', entityId: id, data },
      tx,
    );
  }
}

/** The company's categories with their options, by name. */
export async function listCategories(db: Db, companyId: string): Promise<WorkerCategoryView[]> {
  const rows = await db.workerCategory.findMany({
    where: { companyId },
    include: { options: { orderBy: { position: 'asc' } } },
    orderBy: { name: 'asc' },
  });
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    isActive: c.isActive,
    options: c.options.map((o) => ({ id: o.id, name: o.name, isActive: o.isActive })),
  }));
}

/**
 * Checks a worker's options as sent (category id → option id, null: none) against the
 * company's categories, and returns the changes from `current`. A category or option that
 * is closed can't be chosen anew, but a worker keeps the one they have. `at` is where the
 * worker sits in the request body, so field errors name the form's fields.
 */
export function checkCategoryChoices(
  categories: readonly WorkerCategoryView[],
  sent: Readonly<Record<string, string | null>>,
  current: ReadonlyMap<string, string>,
  at: string,
): { categoryId: string; optionId: string | null }[] {
  const changes: { categoryId: string; optionId: string | null }[] = [];
  for (const [categoryId, optionId] of Object.entries(sent)) {
    if ((current.get(categoryId) ?? null) === optionId) continue;
    const invalid = (message: string) =>
      badRequest('validation', { issues: [{ path: `${at}categories.${categoryId}`, message }] });
    const category = categories.find((c) => c.id === categoryId);
    if (!category) throw notFound('workerCategory.notFound');
    if (!category.isActive) throw conflict('workerCategory.inactive');
    if (optionId !== null) {
      const option = category.options.find((o) => o.id === optionId);
      if (!option) throw invalid('validation.invalid');
      if (!option.isActive) throw invalid('validation.optionClosed');
    }
    changes.push({ categoryId, optionId });
  }
  return changes;
}

/** Writes checkCategoryChoices()'s changes for a worker. */
export async function setCategoryChoices(
  tx: Tx,
  companyId: string,
  workerId: string,
  changes: readonly { categoryId: string; optionId: string | null }[],
): Promise<void> {
  for (const { categoryId, optionId } of changes) {
    if (optionId === null) await tx.workerCategoryValue.deleteMany({ where: { workerId, categoryId, companyId } });
    else {
      await tx.workerCategoryValue.upsert({
        where: { workerId_categoryId: { workerId, categoryId } },
        create: { companyId, workerId, categoryId, optionId },
        update: { optionId },
      });
    }
  }
}

function changesOf<T extends Record<string, unknown>>(before: T, input: Partial<T>) {
  const changed = (Object.keys(input) as (keyof T & string)[]).filter((k) => input[k] !== undefined && input[k] !== before[k]);
  return Object.fromEntries(changed.map((k) => [k, { from: before[k] as Prisma.InputJsonValue, to: input[k] as Prisma.InputJsonValue }]));
}
