import { Injectable } from '@nestjs/common';
import type { Prisma, PayrollRules as RulesRow } from '@prisma/client';
import {
  buildMonthCalendar,
  uzbekistanFixedHolidays,
  workingDays,
  type CalendarDay,
  type WorkingDays,
} from '@puantaj/payroll';
import type { PayRules, RuleSet, UpdateRuleSet } from '@puantaj/schemas';
import { AuditService } from '../audit/audit.service';
import type { CompanyAuthContext } from '../auth/auth.context';
import { badRequest, conflict, notFound } from '../common/api-error';
import { isoDay, todayIn } from '../common/dates';
import { findFirm } from '../organisation/firms.service';
import { PrismaService } from '../prisma/prisma.service';
import { assertMonthsOpen, monthIndex } from './months';

export interface PayRulesVersionView {
  fromYear: number;
  fromMonth: number;
  rules: PayRules;
  setBy: { fullName: string };
  setAt: Date;
}

/** One month of a combination's rules, with everything its working days were worked out from. */
export interface MonthRules {
  /** The version that applies, or null when no rules are set for the month yet. */
  rules: { fromYear: number; fromMonth: number; settings: PayRules } | null;
  calendar: CalendarDay[] | null;
  workingDays: WorkingDays | null;
}

type Db = Prisma.TransactionClient | PrismaService;

/** Why a rule set can't pay a worker (AGENTS.md: Pay rule sets). */
export type CombinationProblem =
  /** The company hasn't chosen its pay categories for the month */
  | { code: 'noPayCategories' }
  /** The worker's option is not set in these pay categories */
  | { code: 'categoryNotSet'; categoryIds: string[] }
  /** The worker's combination (option ids in the pay categories' order) has no rules for the month */
  | { code: 'noCategoryRules'; optionIds: string[] };

/** The rules that pay a worker's placement in a month (rulesForWorker). */
export interface WorkerRules {
  /** The set the firm, site or company uses; null while none is chosen */
  ruleSet: { id: string; name: string } | null;
  /** The combination whose rules apply */
  combination: { id: string; optionIds: string[] } | null;
  /** The month of the combination's rules */
  month: MonthRules | null;
  problem: CombinationProblem | null;
}

/** A rule set's combination of the pay categories' options, by its option ids. */
export interface RuleSetVariantView {
  id: string;
  /** One per category */
  options: { categoryId: string; optionId: string }[];
  /** The first month it has rules for, or null before they are set. */
  rulesFrom: { year: number; month: number } | null;
}

export interface PayCategoriesView {
  fromYear: number;
  fromMonth: number;
  /** One or two, in their order */
  categoryIds: string[];
  setBy: { fullName: string };
  setAt: Date;
}

export interface PayRoundingView {
  fromYear: number;
  fromMonth: number;
  step: string;
  setBy: { fullName: string };
  setAt: Date;
}

/** A combination's key: its option ids sorted, so the order they are given in doesn't matter. */
const variantKey = (optionIds: readonly string[]) => [...optionIds].sort().join(',');

/** Who chooses a rule set: the company, a site or a firm. */
export type RuleSetOwner = { company: true } | { siteId: string } | { firmId: string };

/** The company's choices are the uses without a site or firm. */
const ownerWhere = (owner: RuleSetOwner) => ('company' in owner ? { siteId: null, firmId: null } : owner);

type Month = { year: number; month: number };
/** Rows versioned by month that apply in a month: from it or earlier. */
const upTo = (year: number, month: number) => ({ OR: [{ fromYear: { lt: year } }, { fromYear: year, fromMonth: { lte: month } }] });
/** Rows versioned by month that start after a month. */
const after = (from: Month) => ({ OR: [{ fromYear: { gt: from.year } }, { fromYear: from.year, fromMonth: { gt: from.month } }] });
const NEWEST_FIRST = [{ fromYear: 'desc' }, { fromMonth: 'desc' }] satisfies Prisma.PayrollRulesOrderByWithRelationInput[];
const OLDEST_FIRST = [{ fromYear: 'asc' }, { fromMonth: 'asc' }] satisfies Prisma.PayrollRulesOrderByWithRelationInput[];
/** The month a version starts in, or null: the first month a version at `from` doesn't reach. */
const startOf = (row: { fromYear: number; fromMonth: number } | null) => row && { year: row.fromYear, month: row.fromMonth };

export interface RuleSetView {
  id: string;
  name: string;
  isActive: boolean;
  /** The first month one of its combinations has rules for, or null before they are set. */
  rulesFrom: { year: number; month: number } | null;
  /** The company, sites and firms using it now, or from a later month. */
  usedBy: { company: boolean; sites: { id: string; name: string }[]; firms: { id: string; name: string }[] };
}

export interface RuleSetUseView {
  fromYear: number;
  fromMonth: number;
  /** null: none of its own from this month (sites and firms only) */
  ruleSet: { id: string; name: string | null } | null;
  setBy: { fullName: string };
  setAt: Date;
}

/**
 * Pay rules (AGENTS.md: Pay rule sets): named rule sets that the company, sites and firms
 * choose from a month, each with rules per combination of the company's pay categories,
 * versioned by month. Also the company's pay categories and rounding step.
 */
@Injectable()
export class PayRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** A rule set of the company, which the company, sites and firms choose; not a combination. */
  async ruleSet(companyId: string, id: string, db: Db = this.prisma) {
    const set = await db.payrollRuleSet.findFirst({ where: { id, companyId, parentId: null } });
    if (!set) throw notFound('ruleSet.notFound');
    return set;
  }

  /** A combination of a rule set, which holds rules and working-days overrides. */
  async combination(companyId: string, id: string, db: Db = this.prisma) {
    const set = await db.payrollRuleSet.findFirst({ where: { id, companyId, parentId: { not: null } } });
    if (!set) throw notFound('ruleSet.notFound');
    return set;
  }

  /** The company's pay categories in a month, in their order; empty before it has chosen them. */
  async payCategoriesIn(companyId: string, year: number, month: number, db: Db = this.prisma): Promise<string[]> {
    const row = await db.payCategoryChoice.findFirst({ where: { companyId, ...upTo(year, month) }, orderBy: NEWEST_FIRST });
    return row ? [row.firstCategoryId, row.secondCategoryId].filter((id) => id !== null) : [];
  }

  /** The company's rounding step of the amount to pay out in a month, or null before it is set. */
  async roundingIn(companyId: string, year: number, month: number, db: Db = this.prisma): Promise<string | null> {
    const row = await db.payRounding.findFirst({ where: { companyId, ...upTo(year, month) }, orderBy: NEWEST_FIRST });
    return row?.step.toString() ?? null;
  }

  /**
   * The rules that pay a worker's placement in a month: the placement's rule set
   * (ruleSetForPlacement), and inside it the combination of the worker's options in the pay
   * categories. `options` are the worker's options of the month by category id. Payroll and
   * checks use only this, so they always agree.
   */
  async rulesForWorker(
    companyId: string,
    placement: { siteId: string; firmId: string | null },
    options: Readonly<Record<string, string>>,
    year: number,
    month: number,
    db: Db = this.prisma,
  ): Promise<WorkerRules> {
    const set = await this.ruleSetForPlacement(companyId, placement, year, month, db);
    return this.rulesInSet(companyId, set, options, year, month, db);
  }

  /** The rules of a set for a worker with these options in a month: its combination's. */
  async rulesInSet(
    companyId: string,
    set: { id: string; name: string | null } | null,
    options: Readonly<Record<string, string>>,
    year: number,
    month: number,
    db: Db = this.prisma,
  ): Promise<WorkerRules> {
    if (!set) return { ruleSet: null, combination: null, month: null, problem: null };
    const ruleSet = { id: set.id, name: set.name! };
    const categories = await this.payCategoriesIn(companyId, year, month, db);
    if (categories.length === 0) return { ruleSet, combination: null, month: null, problem: { code: 'noPayCategories' } };
    const notSet = categories.filter((c) => !options[c]);
    if (notSet.length > 0) return { ruleSet, combination: null, month: null, problem: { code: 'categoryNotSet', categoryIds: notSet } };
    const optionIds = categories.map((c) => options[c]);
    const variant = await db.payrollRuleSet.findFirst({ where: { companyId, parentId: set.id, variantKey: variantKey(optionIds) } });
    const rules = variant && (await this.month(companyId, variant.id, year, month, db));
    if (!variant || !rules?.rules) return { ruleSet, combination: null, month: null, problem: { code: 'noCategoryRules', optionIds } };
    return { ruleSet, combination: { id: variant.id, optionIds }, month: rules, problem: null };
  }

  /**
   * Whether a set has rules for a month: a combination of the month's pay categories has them.
   * The company, sites and firms choose it only then.
   */
  async hasRulesFor(companyId: string, ruleSetId: string, from: Month, db: Db = this.prisma): Promise<boolean> {
    const categories = await this.payCategoriesIn(companyId, from.year, from.month, db);
    if (categories.length === 0) return false;
    const version = await db.payrollRules.findFirst({
      where: {
        companyId,
        ...upTo(from.year, from.month),
        ruleSet: {
          parentId: ruleSetId,
          variantOptions: { every: { categoryId: { in: categories } } },
          AND: categories.map((categoryId) => ({ variantOptions: { some: { categoryId } } })),
        },
      },
    });
    return version !== null;
  }

  /** The rule set the company, a site or a firm itself chose for a month, or null when it has none of its own. */
  private async usedIn(companyId: string, owner: RuleSetOwner, year: number, month: number, db: Db) {
    const use = await db.ruleSetUse.findFirst({
      where: { companyId, ...ownerWhere(owner), ...upTo(year, month) },
      orderBy: NEWEST_FIRST,
      include: { ruleSet: true },
    });
    return use?.ruleSet ?? null;
  }

  /** The rule set that applies at a site in a month: its own, else the company's. null while none is chosen. */
  async ruleSetForSite(companyId: string, siteId: string, year: number, month: number, db: Db = this.prisma) {
    return (await this.usedIn(companyId, { siteId }, year, month, db)) ?? this.usedIn(companyId, { company: true }, year, month, db);
  }

  /**
   * The rule set of a placement in a month (AGENTS.md: Pay rule sets): its firm's, else its
   * site's, else the company's. Pass firmId null while the company doesn't use firms. Payroll
   * and checks use only this.
   */
  async ruleSetForPlacement(
    companyId: string,
    placement: { siteId: string; firmId: string | null },
    year: number,
    month: number,
    db: Db = this.prisma,
  ) {
    const own = placement.firmId ? await this.usedIn(companyId, { firmId: placement.firmId }, year, month, db) : null;
    return own ?? this.ruleSetForSite(companyId, placement.siteId, year, month, db);
  }

  async listRuleSets(auth: CompanyAuthContext): Promise<RuleSetView[]> {
    const companyId = auth.company.id;
    const [sets, uses] = await Promise.all([
      this.prisma.payrollRuleSet.findMany({
        where: { companyId, parentId: null },
        include: {
          variants: { select: { versions: { select: { fromYear: true, fromMonth: true }, orderBy: OLDEST_FIRST, take: 1 } } },
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.ruleSetUse.findMany({
        where: { companyId },
        include: { site: { select: { id: true, name: true } }, firm: { select: { id: true, name: true } } },
      }),
    ]);
    const live = liveUses(uses, currentMonth(auth));
    return sets.map((set) => {
      const own = live.filter((u) => u.ruleSetId === set.id);
      const first = set.variants
        .flatMap((v) => v.versions)
        .sort((x, y) => monthIndex(x.fromYear, x.fromMonth) - monthIndex(y.fromYear, y.fromMonth))[0];
      return {
        id: set.id,
        name: set.name!,
        isActive: set.isActive,
        rulesFrom: first ? { year: first.fromYear, month: first.fromMonth } : null,
        usedBy: {
          company: own.some((u) => !u.siteId && !u.firmId),
          sites: unique(own.flatMap((u) => (u.site ? [u.site] : []))),
          firms: unique(own.flatMap((u) => (u.firm ? [u.firm] : []))),
        },
      };
    });
  }

  async createRuleSet(auth: CompanyAuthContext, input: RuleSet): Promise<{ id: string }> {
    const companyId = auth.company.id;
    return this.prisma.$transaction(async (tx) => {
      await this.assertNameFree(tx, companyId, input.name, null);
      const row = await tx.payrollRuleSet.create({ data: { companyId, name: input.name } });
      await this.audit.record(
        { action: 'ruleSet.create', companyId, auth, entityType: 'PayrollRuleSet', entityId: row.id, data: { name: input.name } },
        tx,
      );
      return { id: row.id };
    });
  }

  async updateRuleSet(auth: CompanyAuthContext, id: string, input: UpdateRuleSet): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const before = await this.ruleSet(companyId, id, tx);
      if (input.name !== undefined && input.name.toLowerCase() !== before.name!.toLowerCase()) {
        await this.assertNameFree(tx, companyId, input.name, id);
      }
      if (input.isActive === false && before.isActive) {
        const uses = await tx.ruleSetUse.findMany({ where: { companyId } });
        if (liveUses(uses, currentMonth(auth)).some((u) => u.ruleSetId === id)) throw conflict('ruleSet.inUse');
      }
      await tx.payrollRuleSet.update({ where: { id }, data: input });
      await this.audit.record(
        {
          action: 'ruleSet.update',
          companyId,
          auth,
          entityType: 'PayrollRuleSet',
          entityId: id,
          data: { from: { name: before.name, isActive: before.isActive }, to: input },
        },
        tx,
      );
    });
  }

  /** The rule sets the company, a site or a firm has chosen, newest first. */
  async listUses(companyId: string, owner: RuleSetOwner): Promise<RuleSetUseView[]> {
    await this.assertOwner(this.prisma, companyId, owner);
    const rows = await this.prisma.ruleSetUse.findMany({
      where: { companyId, ...ownerWhere(owner) },
      include: { ruleSet: { select: { id: true, name: true } }, setBy: { select: { fullName: true } } },
      orderBy: NEWEST_FIRST,
    });
    return rows.map((u) => ({ fromYear: u.fromYear, fromMonth: u.fromMonth, ruleSet: u.ruleSet, setBy: u.setBy, setAt: u.setAt }));
  }

  /**
   * Chooses the rule set the company, a site or a firm uses from a month on, until its next
   * choice. null (sites and firms only): none of its own.
   */
  async setUse(auth: CompanyAuthContext, owner: RuleSetOwner, from: Month, ruleSetId: string | null): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      await this.assertOwner(tx, companyId, owner);
      await assertMonthsOpen(tx, companyId, from, await this.nextUseStart(tx, companyId, owner, from));
      if (ruleSetId) {
        const set = await this.ruleSet(companyId, ruleSetId, tx);
        if (!set.isActive) throw conflict('ruleSet.inactive');
        if (!(await this.hasRulesFor(companyId, ruleSetId, from, tx))) throw conflict('ruleSet.noRulesForMonth');
      }
      const before = await tx.ruleSetUse.findFirst({ where: { companyId, ...ownerWhere(owner), fromYear: from.year, fromMonth: from.month } });
      const data = { ruleSetId, setById: auth.user.id, setAt: new Date() };
      const row = before
        ? await tx.ruleSetUse.update({ where: { id: before.id }, data })
        : await tx.ruleSetUse.create({ data: { companyId, ...ownerWhere(owner), fromYear: from.year, fromMonth: from.month, ...data } });
      await this.audit.record(
        {
          action: 'ruleSet.use',
          companyId,
          auth,
          entityType: 'RuleSetUse',
          entityId: row.id,
          data: { ...owner, fromYear: from.year, fromMonth: from.month, from: before?.ruleSetId ?? null, to: ruleSetId },
        },
        tx,
      );
    });
  }

  /** Removes a choice: its months go back to the choice before it. */
  async removeUse(auth: CompanyAuthContext, owner: RuleSetOwner, from: Month): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      await this.assertOwner(tx, companyId, owner);
      const row = await tx.ruleSetUse.findFirst({ where: { companyId, ...ownerWhere(owner), fromYear: from.year, fromMonth: from.month } });
      if (!row) throw notFound('ruleSet.useNotFound');
      await assertMonthsOpen(tx, companyId, from, await this.nextUseStart(tx, companyId, owner, from));
      await tx.ruleSetUse.delete({ where: { id: row.id } });
      await this.audit.record(
        {
          action: 'ruleSet.useDelete',
          companyId,
          auth,
          entityType: 'RuleSetUse',
          entityId: row.id,
          data: { ...owner, fromYear: from.year, fromMonth: from.month, from: row.ruleSetId },
        },
        tx,
      );
    });
  }

  /** The company's pay categories, newest first (AGENTS.md: Pay rule sets). */
  async listPayCategories(companyId: string): Promise<PayCategoriesView[]> {
    const rows = await this.prisma.payCategoryChoice.findMany({
      where: { companyId },
      include: { setBy: { select: { fullName: true } } },
      orderBy: NEWEST_FIRST,
    });
    return rows.map((r) => ({
      fromYear: r.fromYear,
      fromMonth: r.fromMonth,
      categoryIds: [r.firstCategoryId, r.secondCategoryId].filter((id) => id !== null),
      setBy: r.setBy,
      setAt: r.setAt,
    }));
  }

  /** Chooses the company's pay categories from a month on, until its next choice. A closed category can't be chosen anew. */
  async setPayCategories(auth: CompanyAuthContext, from: Month, categoryIds: readonly string[]): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const next = await tx.payCategoryChoice.findFirst({ where: { companyId, ...after(from) }, orderBy: OLDEST_FIRST });
      await assertMonthsOpen(tx, companyId, from, startOf(next));
      const categories = await tx.workerCategory.findMany({ where: { companyId, id: { in: [...categoryIds] } } });
      for (const id of categoryIds) {
        const category = categories.find((c) => c.id === id);
        if (!category) throw notFound('workerCategory.notFound');
        if (!category.isActive) throw conflict('workerCategory.inactive');
      }
      const key = { companyId_fromYear_fromMonth: { companyId, fromYear: from.year, fromMonth: from.month } };
      const before = await tx.payCategoryChoice.findUnique({ where: key });
      const data = { firstCategoryId: categoryIds[0], secondCategoryId: categoryIds[1] ?? null, setById: auth.user.id, setAt: new Date() };
      const row = await tx.payCategoryChoice.upsert({
        where: key,
        create: { companyId, fromYear: from.year, fromMonth: from.month, ...data },
        update: data,
      });
      await this.audit.record(
        {
          action: 'payCategories.set',
          companyId,
          auth,
          entityType: 'PayCategoryChoice',
          entityId: row.id,
          data: {
            fromYear: from.year,
            fromMonth: from.month,
            from: before ? [before.firstCategoryId, before.secondCategoryId].filter((id) => id !== null) : null,
            to: [...categoryIds],
          },
        },
        tx,
      );
    });
  }

  /** Removes a choice of pay categories: its months go back to the choice before it. */
  async removePayCategories(auth: CompanyAuthContext, from: Month): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const key = { companyId_fromYear_fromMonth: { companyId, fromYear: from.year, fromMonth: from.month } };
      const row = await tx.payCategoryChoice.findUnique({ where: key });
      if (!row) throw notFound('payCategories.notFound');
      const next = await tx.payCategoryChoice.findFirst({ where: { companyId, ...after(from) }, orderBy: OLDEST_FIRST });
      await assertMonthsOpen(tx, companyId, from, startOf(next));
      await tx.payCategoryChoice.delete({ where: key });
      await this.audit.record(
        {
          action: 'payCategories.delete',
          companyId,
          auth,
          entityType: 'PayCategoryChoice',
          entityId: row.id,
          data: { fromYear: from.year, fromMonth: from.month, from: [row.firstCategoryId, row.secondCategoryId].filter((id) => id !== null) },
        },
        tx,
      );
    });
  }

  /** The company's rounding steps, newest first (AGENTS.md: Pay model). */
  async listRounding(companyId: string): Promise<PayRoundingView[]> {
    const rows = await this.prisma.payRounding.findMany({
      where: { companyId },
      include: { setBy: { select: { fullName: true } } },
      orderBy: NEWEST_FIRST,
    });
    return rows.map((r) => ({ fromYear: r.fromYear, fromMonth: r.fromMonth, step: r.step.toString(), setBy: r.setBy, setAt: r.setAt }));
  }

  /** Sets the rounding step from a month on, until its next row, replacing that month's if any. */
  async setRounding(auth: CompanyAuthContext, from: Month, step: string): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const next = await tx.payRounding.findFirst({ where: { companyId, ...after(from) }, orderBy: OLDEST_FIRST });
      await assertMonthsOpen(tx, companyId, from, startOf(next));
      const key = { companyId_fromYear_fromMonth: { companyId, fromYear: from.year, fromMonth: from.month } };
      const before = await tx.payRounding.findUnique({ where: key });
      const data = { step, setById: auth.user.id, setAt: new Date() };
      const row = await tx.payRounding.upsert({
        where: key,
        create: { companyId, fromYear: from.year, fromMonth: from.month, ...data },
        update: data,
      });
      await this.audit.record(
        {
          action: 'payRounding.set',
          companyId,
          auth,
          entityType: 'PayRounding',
          entityId: row.id,
          data: { fromYear: from.year, fromMonth: from.month, from: before?.step.toString() ?? null, to: step },
        },
        tx,
      );
    });
  }

  /** Removes a rounding step: its months go back to the one before it. */
  async removeRounding(auth: CompanyAuthContext, from: Month): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const key = { companyId_fromYear_fromMonth: { companyId, fromYear: from.year, fromMonth: from.month } };
      const row = await tx.payRounding.findUnique({ where: key });
      if (!row) throw notFound('payRounding.notFound');
      const next = await tx.payRounding.findFirst({ where: { companyId, ...after(from) }, orderBy: OLDEST_FIRST });
      await assertMonthsOpen(tx, companyId, from, startOf(next));
      await tx.payRounding.delete({ where: key });
      await this.audit.record(
        {
          action: 'payRounding.delete',
          companyId,
          auth,
          entityType: 'PayRounding',
          entityId: row.id,
          data: { fromYear: from.year, fromMonth: from.month, from: row.step.toString() },
        },
        tx,
      );
    });
  }

  /** A set's combinations that have been added, each with its options. */
  async listVariants(companyId: string, ruleSetId: string): Promise<RuleSetVariantView[]> {
    const set = await this.ruleSet(companyId, ruleSetId);
    const rows = await this.prisma.payrollRuleSet.findMany({
      where: { companyId, parentId: set.id },
      include: {
        variantOptions: { select: { categoryId: true, optionId: true } },
        versions: { select: { fromYear: true, fromMonth: true }, orderBy: OLDEST_FIRST, take: 1 },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      options: r.variantOptions,
      rulesFrom: startOf(r.versions[0] ?? null),
    }));
  }

  /**
   * Adds a combination of a set: one option of each of the company's pay categories (of any
   * month). Its rules are then saved with setRules, starting as a copy the person chooses.
   */
  async createVariant(auth: CompanyAuthContext, ruleSetId: string, optionIds: readonly string[]): Promise<{ id: string }> {
    const companyId = auth.company.id;
    return this.prisma.$transaction(async (tx) => {
      const set = await this.ruleSet(companyId, ruleSetId, tx);
      const options = await tx.workerCategoryOption.findMany({ where: { companyId, id: { in: [...optionIds] } } });
      if (options.length !== optionIds.length) throw notFound('workerCategory.optionNotFound');
      if (new Set(options.map((o) => o.categoryId)).size !== options.length) {
        throw badRequest('validation', { issues: [{ path: 'optionIds', message: 'validation.categoryTwice' }] });
      }
      const categories = variantKey(options.map((o) => o.categoryId));
      const choices = await tx.payCategoryChoice.findMany({ where: { companyId } });
      if (!choices.some((c) => variantKey([c.firstCategoryId, c.secondCategoryId].filter((id) => id !== null)) === categories)) {
        throw conflict('ruleSet.notPayCategories');
      }
      const key = variantKey(optionIds);
      if (await tx.payrollRuleSet.findFirst({ where: { companyId, parentId: set.id, variantKey: key } })) {
        throw conflict('ruleSet.variantExists');
      }
      const row = await tx.payrollRuleSet.create({ data: { companyId, parentId: set.id, variantKey: key } });
      await tx.ruleSetVariantOption.createMany({
        data: options.map((o) => ({ companyId, ruleSetId: row.id, categoryId: o.categoryId, optionId: o.id })),
      });
      await this.audit.record(
        {
          action: 'ruleSet.addVariant',
          companyId,
          auth,
          entityType: 'PayrollRuleSet',
          entityId: set.id,
          data: { variantId: row.id, optionIds: [...optionIds] },
        },
        tx,
      );
      return { id: row.id };
    });
  }

  /** A combination's rules, newest first. */
  async listRules(companyId: string, combinationId: string): Promise<PayRulesVersionView[]> {
    const set = await this.combination(companyId, combinationId);
    const rows = await this.prisma.payrollRules.findMany({
      where: { companyId, ruleSetId: set.id },
      include: { setBy: { select: { fullName: true } } },
      orderBy: NEWEST_FIRST,
    });
    return rows.map((row) => ({ fromYear: row.fromYear, fromMonth: row.fromMonth, rules: toPayRules(row), setBy: row.setBy, setAt: row.setAt }));
  }

  /** Saves a combination's rules from a month on, replacing that month's version if any. */
  async setRules(auth: CompanyAuthContext, combinationId: string, from: Month, rules: PayRules): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const set = await this.combination(companyId, combinationId, tx);
      await assertMonthsOpen(tx, companyId, from, await this.nextVersionStart(tx, set.id, from));

      const key = { ruleSetId_fromYear_fromMonth: { ruleSetId: set.id, fromYear: from.year, fromMonth: from.month } };
      const before = await tx.payrollRules.findUnique({ where: key });
      const data = { ...toColumns(rules), setById: auth.user.id, setAt: new Date() };
      await tx.payrollRules.upsert({
        where: key,
        create: { companyId, ruleSetId: set.id, fromYear: from.year, fromMonth: from.month, ...data },
        update: data,
      });
      await this.audit.record(
        {
          action: 'payRules.set',
          companyId,
          auth,
          entityType: 'PayrollRuleSet',
          entityId: set.id,
          data: {
            fromYear: from.year,
            fromMonth: from.month,
            before: before ? (toPayRules(before) as unknown as Prisma.InputJsonObject) : null,
            after: rules as unknown as Prisma.InputJsonObject,
          },
        },
        tx,
      );
    });
  }

  /**
   * Removes a version of a combination's rules: its months fall back to the version before.
   * Refused when the company, a site or a firm chose the set for a month that would then have
   * no rules.
   */
  async removeRules(auth: CompanyAuthContext, combinationId: string, from: Month): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const set = await this.combination(companyId, combinationId, tx);
      const key = { ruleSetId_fromYear_fromMonth: { ruleSetId: set.id, fromYear: from.year, fromMonth: from.month } };
      const row = await tx.payrollRules.findUnique({ where: key });
      if (!row) throw notFound('payRules.notFound');
      await assertMonthsOpen(tx, companyId, from, await this.nextVersionStart(tx, set.id, from));
      await tx.payrollRules.delete({ where: key });
      const uses = await tx.ruleSetUse.findMany({ where: { companyId, ruleSetId: set.parentId } });
      for (const u of uses) {
        if (!(await this.hasRulesFor(companyId, set.parentId!, { year: u.fromYear, month: u.fromMonth }, tx))) {
          throw conflict('ruleSet.inUse');
        }
      }
      await this.audit.record(
        {
          action: 'payRules.delete',
          companyId,
          auth,
          entityType: 'PayrollRuleSet',
          entityId: set.id,
          data: { fromYear: from.year, fromMonth: from.month, before: toPayRules(row) as unknown as Prisma.InputJsonObject },
        },
        tx,
      );
    });
  }

  private async assertOwner(db: Db, companyId: string, owner: RuleSetOwner) {
    if ('firmId' in owner) {
      await findFirm(db, companyId, owner.firmId, owner.firmId);
    } else if ('siteId' in owner && !(await db.site.findFirst({ where: { id: owner.siteId, companyId } }))) {
      throw notFound('site.notFound');
    }
  }

  /** Start of the owner's choice after `from`, i.e. the first month a choice at `from` doesn't reach. */
  private async nextUseStart(db: Db, companyId: string, owner: RuleSetOwner, from: Month) {
    const next = await db.ruleSetUse.findFirst({ where: { companyId, ...ownerWhere(owner), ...after(from) }, orderBy: OLDEST_FIRST });
    return startOf(next);
  }

  /** Names are unique in the company, ignoring case (also a unique index). */
  private async assertNameFree(db: Db, companyId: string, name: string, exceptId: string | null) {
    const other = await db.payrollRuleSet.findFirst({
      where: { companyId, name: { equals: name, mode: 'insensitive' }, NOT: exceptId ? { id: exceptId } : undefined },
    });
    if (other) throw conflict('ruleSet.nameTaken');
  }

  /**
   * The rules, calendar and working days of a month of a combination. The one place that
   * works these out, so Settings and payroll always agree.
   */
  async month(companyId: string, ruleSetId: string, year: number, month: number, db: Db = this.prisma): Promise<MonthRules> {
    const version = await db.payrollRules.findFirst({ where: { companyId, ruleSetId, ...upTo(year, month) }, orderBy: NEWEST_FIRST });
    if (!version) return { rules: null, calendar: null, workingDays: null };

    const settings = toPayRules(version);
    const calendar = await this.calendar(companyId, year, month, settings.restWeekdays, db);
    const override = await db.workingDaysOverride.findFirst({
      where: { companyId, ruleSetId, year, month },
      orderBy: { seq: 'desc' },
    });
    return {
      rules: { fromYear: version.fromYear, fromMonth: version.fromMonth, settings },
      calendar,
      workingDays: workingDays(calendar, override?.workingDays ?? null),
    };
  }

  /** The month's days: Uzbekistan's fixed holidays plus the holidays the company entered. */
  async calendar(companyId: string, year: number, month: number, restWeekdays: readonly number[], db: Db = this.prisma) {
    const entered = await db.holiday.findMany({
      where: {
        companyId,
        date: { gte: new Date(Date.UTC(year, month - 1, 1)), lt: new Date(Date.UTC(year, month, 1)) },
      },
    });
    const prefix = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-`;
    const fixed = uzbekistanFixedHolidays(year)
      .map((h) => h.date)
      .filter((date) => date.startsWith(prefix));
    return buildMonthCalendar(year, month, {
      restWeekdays,
      holidays: [...fixed, ...entered.filter((h) => h.kind !== 'WORKING_DAY').map((h) => isoDay(h.date))],
      extraWorkdays: entered.filter((h) => h.kind === 'WORKING_DAY').map((h) => isoDay(h.date)),
    });
  }

  /** Start of the version after `from`, i.e. the first month a version at `from` doesn't reach. */
  private async nextVersionStart(db: Db, ruleSetId: string, from: Month) {
    return startOf(await db.payrollRules.findFirst({ where: { ruleSetId, ...after(from) }, orderBy: OLDEST_FIRST }));
  }
}

function currentMonth(auth: CompanyAuthContext) {
  const today = todayIn(auth.company.timezone);
  return monthIndex(Number(today.slice(0, 4)), Number(today.slice(5, 7)));
}

/** The uses that apply now or from a later month: each owner's latest up to now, and all its later ones. */
function liveUses<T extends { siteId: string | null; firmId: string | null; fromYear: number; fromMonth: number }>(uses: readonly T[], now: number): T[] {
  const newestFirst = [...uses].sort((x, y) => monthIndex(y.fromYear, y.fromMonth) - monthIndex(x.fromYear, x.fromMonth));
  const seen = new Set<string>();
  return newestFirst.filter((u) => {
    if (monthIndex(u.fromYear, u.fromMonth) > now) return true;
    const owner = u.siteId ?? u.firmId ?? 'company';
    if (seen.has(owner)) return false;
    seen.add(owner);
    return true;
  });
}

function unique<T extends { id: string; name: string }>(rows: readonly T[]): T[] {
  return [...new Map(rows.map((r) => [r.id, r])).values()].sort((x, y) => x.name.localeCompare(y.name));
}

function toPayRules(row: RulesRow): PayRules {
  return {
    restWeekdays: [...row.restWeekdays].sort((a, b) => a - b),
    normalHoursPerDay: row.normalHoursPerDay.toString(),
    overtimeMultiplier: row.overtimeMultiplier.toString(),
    restDayMultiplier: row.restDayMultiplier.toString(),
    holidayMultiplier: row.holidayMultiplier.toString(),
    absence: {
      LEAVE: { paid: row.leavePaid, hoursPerDay: row.leaveHoursPerDay?.toString() ?? null },
      SICK: { paid: row.sickPaid, hoursPerDay: row.sickHoursPerDay?.toString() ?? null },
      TRAVEL: { paid: row.travelDayPaid, hoursPerDay: row.travelDayHoursPerDay?.toString() ?? null },
    },
    travelPayMode: row.travelPayMode,
  };
}

function toColumns(rules: PayRules) {
  return {
    restWeekdays: rules.restWeekdays,
    normalHoursPerDay: rules.normalHoursPerDay,
    overtimeMultiplier: rules.overtimeMultiplier,
    restDayMultiplier: rules.restDayMultiplier,
    holidayMultiplier: rules.holidayMultiplier,
    leavePaid: rules.absence.LEAVE.paid,
    leaveHoursPerDay: rules.absence.LEAVE.hoursPerDay,
    sickPaid: rules.absence.SICK.paid,
    sickHoursPerDay: rules.absence.SICK.hoursPerDay,
    travelDayPaid: rules.absence.TRAVEL.paid,
    travelDayHoursPerDay: rules.absence.TRAVEL.hoursPerDay,
    travelPayMode: rules.travelPayMode,
  };
}
