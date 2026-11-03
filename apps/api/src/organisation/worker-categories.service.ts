import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CategoryOption, UpdateCategoryOption, UpdateWorkerCategory, WorkerCategory } from '@puantaj/schemas';
import { AuditService } from '../audit/audit.service';
import type { CompanyAuthContext } from '../auth/auth.context';
import { badRequest, conflict, notFound } from '../common/api-error';
import { todayIn } from '../common/dates';
import { assertMonthsOpen, monthIndex } from '../pay-rules/months';
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
 * workers, each with its options. Everyone sees them; owners and admins create, rename and
 * (de)activate them. They change pay only where a rule set splits by them.
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
      if (input.isActive === false && before.isActive) await this.assertNotSplitBy(tx, auth, id);
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

  /**
   * A category a rule set splits by now or from a later month can't be deactivated (AGENTS.md:
   * Rule sets split by categories): each set's split of the current month, and all its later ones.
   */
  private async assertNotSplitBy(tx: Tx, auth: CompanyAuthContext, categoryId: string) {
    const today = todayIn(auth.company.timezone);
    const now = monthIndex(Number(today.slice(0, 4)), Number(today.slice(5, 7)));
    const splits = await tx.ruleSetSplit.findMany({
      where: { companyId: auth.company.id },
      orderBy: [{ fromYear: 'desc' }, { fromMonth: 'desc' }],
    });
    const seen = new Set<string>();
    const live = splits.filter((s) => {
      if (monthIndex(s.fromYear, s.fromMonth) > now) return true;
      if (seen.has(s.ruleSetId)) return false;
      seen.add(s.ruleSetId);
      return true;
    });
    if (live.some((s) => s.firstCategoryId === categoryId || s.secondCategoryId === categoryId)) {
      throw conflict('workerCategory.inUse');
    }
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

/**
 * Writes checkCategoryChoices()'s changes for a worker from a month on, until the worker's
 * next row in each category, replacing a row of that month. Refused when a change would reach
 * a locked month (AGENTS.md: Worker categories).
 */
export async function setCategoryChoices(
  tx: Tx,
  companyId: string,
  workerId: string,
  from: { year: number; month: number },
  changes: readonly { categoryId: string; optionId: string | null }[],
  setById: string,
): Promise<void> {
  for (const { categoryId, optionId } of changes) {
    const next = await tx.workerCategoryValue.findFirst({
      where: { workerId, categoryId, OR: [{ fromYear: { gt: from.year } }, { fromYear: from.year, fromMonth: { gt: from.month } }] },
      orderBy: [{ fromYear: 'asc' }, { fromMonth: 'asc' }],
    });
    await assertMonthsOpen(tx, companyId, from, next && { year: next.fromYear, month: next.fromMonth });
    const data = { optionId, setById, setAt: new Date() };
    await tx.workerCategoryValue.upsert({
      where: { workerId_categoryId_fromYear_fromMonth: { workerId, categoryId, fromYear: from.year, fromMonth: from.month } },
      create: { companyId, workerId, categoryId, fromYear: from.year, fromMonth: from.month, ...data },
      update: data,
    });
  }
}

/** Newest first: the first row of a category up to a month is the one that counts. */
export const CATEGORY_VALUE_ORDER = [
  { fromYear: 'desc' },
  { fromMonth: 'desc' },
] as const satisfies Prisma.WorkerCategoryValueOrderByWithRelationInput[];

/**
 * A worker's options in a month, by category id, from their rows (any order); categories not
 * set are left out.
 */
export function optionsAt(
  rows: readonly { categoryId: string; optionId: string | null; fromYear: number; fromMonth: number }[],
  { year, month }: { year: number; month: number },
): Record<string, string> {
  const at = monthIndex(year, month);
  const latest = new Map<string, { index: number; optionId: string | null }>();
  for (const r of rows) {
    const index = monthIndex(r.fromYear, r.fromMonth);
    if (index > at) continue;
    const seen = latest.get(r.categoryId);
    if (!seen || index > seen.index) latest.set(r.categoryId, { index, optionId: r.optionId });
  }
  return Object.fromEntries([...latest].flatMap(([id, v]) => (v.optionId ? [[id, v.optionId]] : [])));
}

/** Each worker's options in a month (optionsAt), by worker id. */
export async function categoriesInMonth(
  db: Db,
  companyId: string,
  workerIds: readonly string[],
  year: number,
  month: number,
): Promise<Map<string, Record<string, string>>> {
  const rows = await db.workerCategoryValue.findMany({
    where: {
      companyId,
      workerId: { in: [...workerIds] },
      OR: [{ fromYear: { lt: year } }, { fromYear: year, fromMonth: { lte: month } }],
    },
    select: { workerId: true, categoryId: true, optionId: true, fromYear: true, fromMonth: true },
  });
  return new Map(workerIds.map((id) => [id, optionsAt(rows.filter((r) => r.workerId === id), { year, month })]));
}

function changesOf<T extends Record<string, unknown>>(before: T, input: Partial<T>) {
  const changed = (Object.keys(input) as (keyof T & string)[]).filter((k) => input[k] !== undefined && input[k] !== before[k]);
  return Object.fromEntries(changed.map((k) => [k, { from: before[k] as Prisma.InputJsonValue, to: input[k] as Prisma.InputJsonValue }]));
}
