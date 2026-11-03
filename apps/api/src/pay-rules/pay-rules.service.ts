import { Injectable } from '@nestjs/common';
import type { Prisma, PayrollRules as RulesRow } from '@prisma/client';
import {
  buildMonthCalendar,
  uzbekistanFixedHolidays,
  workingDays,
  type CalendarDay,
  type WorkingDays,
} from '@puantaj/payroll';
import type { PayRules, RuleSet, RuleSetPayRules, UpdateRuleSet } from '@puantaj/schemas';
import { AuditService } from '../audit/audit.service';
import type { CompanyAuthContext } from '../auth/auth.context';
import { badRequest, conflict, notFound } from '../common/api-error';
import { isoDay, todayIn } from '../common/dates';
import { findFirm } from '../organisation/firms.service';
import { PrismaService } from '../prisma/prisma.service';
import { assertMonthsOpen, monthIndex } from './months';

export interface PayRulesVersionView<R = PayRules> {
  fromYear: number;
  fromMonth: number;
  rules: R;
  setBy: { fullName: string };
  setAt: Date;
}

/**
 * Rules as stored. Rounding is company-wide (AGENTS.md: Pay model): only the company
 * default rule set has a rounding step; named rule sets have null.
 */
export type StoredPayRules = Omit<PayRules, 'payRoundingStep'> & { payRoundingStep: string | null };

/** One month of a rule set, with everything its working days were worked out from. */
export interface MonthRules {
  /** The version that applies, or null when no rules are set for the month yet. */
  rules: { fromYear: number; fromMonth: number; settings: StoredPayRules } | null;
  calendar: CalendarDay[] | null;
  workingDays: WorkingDays | null;
}

type Db = Prisma.TransactionClient | PrismaService;

/** Why a split rule set can't pay a worker (AGENTS.md: Rule sets split by categories). */
export type CombinationProblem =
  /** The worker's option is not set in these categories the set splits by */
  | { code: 'categoryNotSet'; categoryIds: string[] }
  /** The worker's combination (option ids in the split's order) has no rules for the month */
  | { code: 'noCategoryRules'; optionIds: string[] };

/** The rules that pay a worker's placement in a month (rulesForWorker). */
export interface WorkerRules {
  /** The set the site or firm uses, or the default; null before any rules are saved */
  ruleSet: { id: string; name: string | null } | null;
  /** The combination whose rules apply, when the set splits by categories */
  combination: { id: string; optionIds: string[] } | null;
  /** The month of the rules that apply: the combination's, else the set's own */
  month: MonthRules | null;
  problem: CombinationProblem | null;
}

/** A split rule set's combination of a split's options, by its option ids. */
export interface RuleSetVariantView {
  id: string;
  /** One per category */
  options: { categoryId: string; optionId: string }[];
  /** The first month it has rules for, or null before they are set. */
  rulesFrom: { year: number; month: number } | null;
}

export interface RuleSetSplitView {
  fromYear: number;
  fromMonth: number;
  /** Empty: no split from this month */
  categoryIds: string[];
  setBy: { fullName: string };
  setAt: Date;
}

/** A combination's key: its option ids sorted, so the order they are given in doesn't matter. */
const variantKey = (optionIds: readonly string[]) => [...optionIds].sort().join(',');

/** Who uses a rule set: a site or a firm. */
export type RuleSetOwner = { siteId: string } | { firmId: string };

export interface RuleSetView {
  id: string;
  /** null: the company default */
  name: string | null;
  isActive: boolean;
  /** The first month it has rules for, or null before they are set. */
  rulesFrom: { year: number; month: number } | null;
  /** Sites and firms using it now, or from a later month. */
  usedBy: { sites: { id: string; name: string }[]; firms: { id: string; name: string }[] };
}

export interface RuleSetUseView {
  fromYear: number;
  fromMonth: number;
  /** null: none of its own from this month */
  ruleSet: { id: string; name: string | null } | null;
  setBy: { fullName: string };
  setAt: Date;
}


/**
 * Pay rules, versioned by month: a version applies from its month until the next one. The
 * company default rule set, and the named ones sites and firms share (AGENTS.md: Pay rule sets).
 */
@Injectable()
export class PayRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The company default rule set, or null before its rules are first saved. */
  defaultRuleSet(companyId: string, db: Db = this.prisma) {
    return db.payrollRuleSet.findFirst({ where: { companyId, name: null, parentId: null } });
  }

  /** A named rule set of the company; the default has its own routes and isn't one. */
  async namedRuleSet(companyId: string, id: string, db: Db = this.prisma) {
    const set = await db.payrollRuleSet.findFirst({ where: { id, companyId, name: { not: null } } });
    if (!set) throw notFound('ruleSet.notFound');
    return set;
  }

  /** The company default or a named set, which sites and firms choose and which split by categories; not a combination. */
  async topRuleSet(companyId: string, id: string, db: Db = this.prisma) {
    const set = await db.payrollRuleSet.findFirst({ where: { id, companyId, parentId: null } });
    if (!set) throw notFound('ruleSet.notFound');
    return set;
  }

  /**
   * A set whose rules and working days are kept through its id: a named set or a combination
   * of a split set. The company default has its own routes, which hold the rounding step.
   */
  private async ruleSetById(companyId: string, id: string, db: Db) {
    const set = await db.payrollRuleSet.findFirst({
      where: { id, companyId, OR: [{ name: { not: null } }, { parentId: { not: null } }] },
    });
    if (!set) throw notFound('ruleSet.notFound');
    return set;
  }

  /** ruleSetById() for routes outside this service (working days). */
  editableRuleSet(companyId: string, id: string, db: Db = this.prisma) {
    return this.ruleSetById(companyId, id, db);
  }

  /** The categories a top rule set splits by in a month (AGENTS.md: Rule sets split by categories), in their order; empty: no split. */
  async splitIn(companyId: string, ruleSetId: string, year: number, month: number, db: Db = this.prisma): Promise<string[]> {
    const row = await db.ruleSetSplit.findFirst({
      where: { companyId, ruleSetId, OR: [{ fromYear: { lt: year } }, { fromYear: year, fromMonth: { lte: month } }] },
      orderBy: [{ fromYear: 'desc' }, { fromMonth: 'desc' }],
    });
    return row ? [row.firstCategoryId, row.secondCategoryId].filter((id) => id !== null) : [];
  }

  /**
   * The rules that pay a worker's placement in a month: the placement's rule set
   * (ruleSetForPlacement), and inside it the combination of the worker's options when the set
   * splits by categories. `options` are the worker's options of the month by category id.
   * Payroll and checks use only this, so they always agree.
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
    if (!set) return { ruleSet: null, combination: null, month: null, problem: null };
    const own = await this.month(companyId, set.id, year, month, db);
    const ruleSet = { id: set.id, name: set.name };
    const split = await this.splitIn(companyId, set.id, year, month, db);
    if (split.length === 0 || !own.rules) return { ruleSet, combination: null, month: own, problem: null };
    const notSet = split.filter((c) => !options[c]);
    if (notSet.length > 0) return { ruleSet, combination: null, month: own, problem: { code: 'categoryNotSet', categoryIds: notSet } };
    const optionIds = split.map((c) => options[c]);
    const variant = await db.payrollRuleSet.findFirst({ where: { companyId, parentId: set.id, variantKey: variantKey(optionIds) } });
    const rules = variant && (await this.month(companyId, variant.id, year, month, db));
    if (!variant || !rules?.rules) {
      return { ruleSet, combination: null, month: own, problem: { code: 'noCategoryRules', optionIds } };
    }
    return { ruleSet, combination: { id: variant.id, optionIds }, month: rules, problem: null };
  }

  /** The rule set a site or firm itself uses in a month, or null when it has none of its own. */
  private async usedIn(companyId: string, owner: RuleSetOwner, year: number, month: number, db: Db) {
    const use = await db.ruleSetUse.findFirst({
      where: { companyId, ...owner, OR: [{ fromYear: { lt: year } }, { fromYear: year, fromMonth: { lte: month } }] },
      orderBy: [{ fromYear: 'desc' }, { fromMonth: 'desc' }],
      include: { ruleSet: true },
    });
    return use?.ruleSet ?? null;
  }

  /** The rule set that applies at a site in a month: the one it uses, or the default. null before any rules are saved. */
  async ruleSetForSite(companyId: string, siteId: string, year: number, month: number, db: Db = this.prisma) {
    return (await this.usedIn(companyId, { siteId }, year, month, db)) ?? this.defaultRuleSet(companyId, db);
  }

  /**
   * The rule set of a placement in a month (AGENTS.md: Pay rule sets): its firm's, else its
   * site's, else the default. Pass firmId null while the company doesn't use firms. Payroll
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
        include: { versions: { select: { fromYear: true, fromMonth: true }, orderBy: [{ fromYear: 'asc' }, { fromMonth: 'asc' }], take: 1 } },
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
      const first = set.versions[0];
      return {
        id: set.id,
        name: set.name,
        isActive: set.isActive,
        rulesFrom: first ? { year: first.fromYear, month: first.fromMonth } : null,
        usedBy: {
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
      const before = await this.namedRuleSet(companyId, id, tx);
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

  /** The rule sets a site or firm has used, newest first. */
  async listUses(companyId: string, owner: RuleSetOwner): Promise<RuleSetUseView[]> {
    await this.assertOwner(this.prisma, companyId, owner);
    const rows = await this.prisma.ruleSetUse.findMany({
      where: { companyId, ...owner },
      include: { ruleSet: { select: { id: true, name: true } }, setBy: { select: { fullName: true } } },
      orderBy: [{ fromYear: 'desc' }, { fromMonth: 'desc' }],
    });
    return rows.map((u) => ({ fromYear: u.fromYear, fromMonth: u.fromMonth, ruleSet: u.ruleSet, setBy: u.setBy, setAt: u.setAt }));
  }

  /** Chooses the rule set a site or firm uses from a month on, until its next choice. */
  async setUse(auth: CompanyAuthContext, owner: RuleSetOwner, from: { year: number; month: number }, ruleSetId: string | null): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      await this.assertOwner(tx, companyId, owner);
      await assertMonthsOpen(tx, companyId, from, await this.nextUseStart(tx, companyId, owner, from));
      if (ruleSetId) {
        const set = await this.namedRuleSet(companyId, ruleSetId, tx);
        if (!set.isActive) throw conflict('ruleSet.inactive');
        const version = await tx.payrollRules.findFirst({
          where: { ruleSetId, OR: [{ fromYear: { lt: from.year } }, { fromYear: from.year, fromMonth: { lte: from.month } }] },
        });
        if (!version) throw conflict('ruleSet.noRulesForMonth');
      }
      const before = await tx.ruleSetUse.findFirst({ where: { companyId, ...owner, fromYear: from.year, fromMonth: from.month } });
      const data = { ruleSetId, setById: auth.user.id, setAt: new Date() };
      const row = before
        ? await tx.ruleSetUse.update({ where: { id: before.id }, data })
        : await tx.ruleSetUse.create({ data: { companyId, ...owner, fromYear: from.year, fromMonth: from.month, ...data } });
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
  async removeUse(auth: CompanyAuthContext, owner: RuleSetOwner, from: { year: number; month: number }): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      await this.assertOwner(tx, companyId, owner);
      const row = await tx.ruleSetUse.findFirst({ where: { companyId, ...owner, fromYear: from.year, fromMonth: from.month } });
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

  /** The categories a set has split by, newest first (AGENTS.md: Rule sets split by categories). */
  async listSplits(companyId: string, ruleSetId: string): Promise<RuleSetSplitView[]> {
    const set = await this.topRuleSet(companyId, ruleSetId);
    const rows = await this.prisma.ruleSetSplit.findMany({
      where: { companyId, ruleSetId: set.id },
      include: { setBy: { select: { fullName: true } } },
      orderBy: [{ fromYear: 'desc' }, { fromMonth: 'desc' }],
    });
    return rows.map((r) => ({
      fromYear: r.fromYear,
      fromMonth: r.fromMonth,
      categoryIds: [r.firstCategoryId, r.secondCategoryId].filter((id) => id !== null),
      setBy: r.setBy,
      setAt: r.setAt,
    }));
  }

  /**
   * Chooses the categories a set splits by from a month on, until its next choice; none: no
   * split. A closed category can't be chosen anew.
   */
  async setSplit(auth: CompanyAuthContext, ruleSetId: string, from: { year: number; month: number }, categoryIds: readonly string[]): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const set = await this.topRuleSet(companyId, ruleSetId, tx);
      await assertMonthsOpen(tx, companyId, from, await this.nextSplitStart(tx, set.id, from));
      const categories = await tx.workerCategory.findMany({ where: { companyId, id: { in: [...categoryIds] } } });
      for (const id of categoryIds) {
        const category = categories.find((c) => c.id === id);
        if (!category) throw notFound('workerCategory.notFound');
        if (!category.isActive) throw conflict('workerCategory.inactive');
      }
      const key = { ruleSetId_fromYear_fromMonth: { ruleSetId: set.id, fromYear: from.year, fromMonth: from.month } };
      const before = await tx.ruleSetSplit.findUnique({ where: key });
      const data = {
        firstCategoryId: categoryIds[0] ?? null,
        secondCategoryId: categoryIds[1] ?? null,
        setById: auth.user.id,
        setAt: new Date(),
      };
      const row = await tx.ruleSetSplit.upsert({
        where: key,
        create: { companyId, ruleSetId: set.id, fromYear: from.year, fromMonth: from.month, ...data },
        update: data,
      });
      await this.audit.record(
        {
          action: 'ruleSet.split',
          companyId,
          auth,
          entityType: 'RuleSetSplit',
          entityId: row.id,
          data: {
            ruleSetId: set.id,
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

  /** Removes a split choice: its months go back to the choice before it. */
  async removeSplit(auth: CompanyAuthContext, ruleSetId: string, from: { year: number; month: number }): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const set = await this.topRuleSet(companyId, ruleSetId, tx);
      const key = { ruleSetId_fromYear_fromMonth: { ruleSetId: set.id, fromYear: from.year, fromMonth: from.month } };
      const row = await tx.ruleSetSplit.findUnique({ where: key });
      if (!row) throw notFound('ruleSet.splitNotFound');
      await assertMonthsOpen(tx, companyId, from, await this.nextSplitStart(tx, set.id, from));
      await tx.ruleSetSplit.delete({ where: key });
      await this.audit.record(
        {
          action: 'ruleSet.splitDelete',
          companyId,
          auth,
          entityType: 'RuleSetSplit',
          entityId: row.id,
          data: {
            ruleSetId: set.id,
            fromYear: from.year,
            fromMonth: from.month,
            from: [row.firstCategoryId, row.secondCategoryId].filter((id) => id !== null),
          },
        },
        tx,
      );
    });
  }

  /** A split set's combinations that have been added, each with its options. */
  async listVariants(companyId: string, ruleSetId: string): Promise<RuleSetVariantView[]> {
    const set = await this.topRuleSet(companyId, ruleSetId);
    const rows = await this.prisma.payrollRuleSet.findMany({
      where: { companyId, parentId: set.id },
      include: {
        variantOptions: { select: { categoryId: true, optionId: true } },
        versions: { select: { fromYear: true, fromMonth: true }, orderBy: [{ fromYear: 'asc' }, { fromMonth: 'asc' }], take: 1 },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      options: r.variantOptions,
      rulesFrom: r.versions[0] ? { year: r.versions[0].fromYear, month: r.versions[0].fromMonth } : null,
    }));
  }

  /**
   * Adds a combination of a set: one option of each of one or two categories. Its rules are
   * then saved like a named set's (setNamed), starting as a copy the person chooses.
   */
  async createVariant(auth: CompanyAuthContext, ruleSetId: string, optionIds: readonly string[]): Promise<{ id: string }> {
    const companyId = auth.company.id;
    return this.prisma.$transaction(async (tx) => {
      const set = await this.topRuleSet(companyId, ruleSetId, tx);
      const options = await tx.workerCategoryOption.findMany({ where: { companyId, id: { in: [...optionIds] } } });
      if (options.length !== optionIds.length) throw notFound('workerCategory.optionNotFound');
      if (new Set(options.map((o) => o.categoryId)).size !== options.length) {
        throw badRequest('validation', { issues: [{ path: 'optionIds', message: 'validation.categoryTwice' }] });
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

  /** Start of the set's split choice after `from`, i.e. the first month a choice at `from` doesn't reach. */
  private async nextSplitStart(db: Db, ruleSetId: string, from: { year: number; month: number }) {
    const next = await db.ruleSetSplit.findFirst({
      where: { ruleSetId, OR: [{ fromYear: { gt: from.year } }, { fromYear: from.year, fromMonth: { gt: from.month } }] },
      orderBy: [{ fromYear: 'asc' }, { fromMonth: 'asc' }],
    });
    return next && { year: next.fromYear, month: next.fromMonth };
  }

  private async assertOwner(db: Db, companyId: string, owner: RuleSetOwner) {
    if ('firmId' in owner) {
      await findFirm(db, companyId, owner.firmId, owner.firmId);
    } else if (!(await db.site.findFirst({ where: { id: owner.siteId, companyId } }))) {
      throw notFound('site.notFound');
    }
  }

  /** Start of the owner's choice after `from`, i.e. the first month a choice at `from` doesn't reach. */
  private async nextUseStart(db: Db, companyId: string, owner: RuleSetOwner, from: { year: number; month: number }) {
    const next = await db.ruleSetUse.findFirst({
      where: { companyId, ...owner, OR: [{ fromYear: { gt: from.year } }, { fromYear: from.year, fromMonth: { gt: from.month } }] },
      orderBy: [{ fromYear: 'asc' }, { fromMonth: 'asc' }],
    });
    return next && { year: next.fromYear, month: next.fromMonth };
  }

  /** Names are unique in the company, ignoring case (also a unique index). */
  private async assertNameFree(db: Db, companyId: string, name: string, exceptId: string | null) {
    const other = await db.payrollRuleSet.findFirst({
      where: { companyId, name: { equals: name, mode: 'insensitive' }, NOT: exceptId ? { id: exceptId } : undefined },
    });
    if (other) throw conflict('ruleSet.nameTaken');
  }

  async list(companyId: string): Promise<PayRulesVersionView[]> {
    const set = await this.defaultRuleSet(companyId);
    if (!set) return [];
    const rows = await this.prisma.payrollRules.findMany({
      where: { companyId, ruleSetId: set.id },
      include: { setBy: { select: { fullName: true } } },
      orderBy: [{ fromYear: 'desc' }, { fromMonth: 'desc' }],
    });
    return rows.map((row) => ({
      fromYear: row.fromYear,
      fromMonth: row.fromMonth,
      rules: defaultRules(row),
      setBy: row.setBy,
      setAt: row.setAt,
    }));
  }

  /** A named rule set's rules, newest first. */
  async listNamed(companyId: string, ruleSetId: string): Promise<PayRulesVersionView<RuleSetPayRules>[]> {
    const set = await this.ruleSetById(companyId, ruleSetId, this.prisma);
    const rows = await this.prisma.payrollRules.findMany({
      where: { companyId, ruleSetId: set.id },
      include: { setBy: { select: { fullName: true } } },
      orderBy: [{ fromYear: 'desc' }, { fromMonth: 'desc' }],
    });
    return rows.map((row) => {
      const { payRoundingStep: _, ...rules } = toPayRules(row);
      return { fromYear: row.fromYear, fromMonth: row.fromMonth, rules, setBy: row.setBy, setAt: row.setAt };
    });
  }

  /** Saves a named set's rules from a month on, as set() does for the company default. No rounding step: it is company-wide. */
  async setNamed(auth: CompanyAuthContext, ruleSetId: string, from: { year: number; month: number }, rules: RuleSetPayRules): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const set = await this.ruleSetById(companyId, ruleSetId, tx);
      await assertMonthsOpen(tx, companyId, from, await this.nextVersionStart(tx, set.id, from));

      const key = { ruleSetId_fromYear_fromMonth: { ruleSetId: set.id, fromYear: from.year, fromMonth: from.month } };
      const before = await tx.payrollRules.findUnique({ where: key });
      const data = { ...toColumns({ ...rules, payRoundingStep: null }), setById: auth.user.id, setAt: new Date() };
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
   * Removes a version of a named set: its months fall back to the version before. Refused when
   * a site or firm chose the set for a month that would then have no rules.
   */
  async removeNamed(auth: CompanyAuthContext, ruleSetId: string, from: { year: number; month: number }): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const set = await this.ruleSetById(companyId, ruleSetId, tx);
      const key = { ruleSetId_fromYear_fromMonth: { ruleSetId: set.id, fromYear: from.year, fromMonth: from.month } };
      const row = await tx.payrollRules.findUnique({ where: key });
      if (!row) throw notFound('payRules.notFound');
      await assertMonthsOpen(tx, companyId, from, await this.nextVersionStart(tx, set.id, from));
      const first = await tx.payrollRules.findFirst({
        where: { ruleSetId: set.id, NOT: { id: row.id } },
        orderBy: [{ fromYear: 'asc' }, { fromMonth: 'asc' }],
      });
      const firstIndex = first ? monthIndex(first.fromYear, first.fromMonth) : Infinity;
      const uses = await tx.ruleSetUse.findMany({ where: { companyId, ruleSetId: set.id } });
      if (uses.some((u) => monthIndex(u.fromYear, u.fromMonth) < firstIndex)) throw conflict('ruleSet.inUse');
      await tx.payrollRules.delete({ where: key });
      await this.audit.record(
        {
          action: 'payRules.delete',
          companyId,
          auth,
          entityType: 'PayrollRuleSet',
          entityId: set.id,
          data: {
            fromYear: from.year,
            fromMonth: from.month,
            before: toPayRules(row) as unknown as Prisma.InputJsonObject,
          },
        },
        tx,
      );
    });
  }

  /** Saves the rules that apply from a month on, replacing that month's version if any. */
  async set(auth: CompanyAuthContext, from: { year: number; month: number }, rules: PayRules): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const set =
        (await this.defaultRuleSet(companyId, tx)) ?? (await tx.payrollRuleSet.create({ data: { companyId } }));
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
            before: before ? (defaultRules(before) as unknown as Prisma.InputJsonObject) : null,
            after: rules as unknown as Prisma.InputJsonObject,
          },
        },
        tx,
      );
    });
  }

  /** Removes the version from a month: the months it covered fall back to the version before it. */
  async remove(auth: CompanyAuthContext, from: { year: number; month: number }): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const set = await this.defaultRuleSet(companyId, tx);
      const key = set && {
        ruleSetId_fromYear_fromMonth: { ruleSetId: set.id, fromYear: from.year, fromMonth: from.month },
      };
      const row = key && (await tx.payrollRules.findUnique({ where: key }));
      if (!set || !key || !row) throw notFound('payRules.notFound');
      await assertMonthsOpen(tx, companyId, from, await this.nextVersionStart(tx, set.id, from));
      await tx.payrollRules.delete({ where: key });
      await this.audit.record(
        {
          action: 'payRules.delete',
          companyId,
          auth,
          entityType: 'PayrollRuleSet',
          entityId: set.id,
          data: {
            fromYear: from.year,
            fromMonth: from.month,
            before: defaultRules(row) as unknown as Prisma.InputJsonObject,
          },
        },
        tx,
      );
    });
  }

  /**
   * The rules, calendar and working days of a month of a rule set. The one place that
   * works these out, so Settings and payroll always agree.
   */
  async month(companyId: string, ruleSetId: string, year: number, month: number, db: Db = this.prisma): Promise<MonthRules> {
    const version = await db.payrollRules.findFirst({
      where: {
        companyId,
        ruleSetId,
        OR: [{ fromYear: { lt: year } }, { fromYear: year, fromMonth: { lte: month } }],
      },
      orderBy: [{ fromYear: 'desc' }, { fromMonth: 'desc' }],
    });
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
  private async nextVersionStart(db: Db, ruleSetId: string, from: { year: number; month: number }) {
    const next = await db.payrollRules.findFirst({
      where: {
        ruleSetId,
        OR: [{ fromYear: { gt: from.year } }, { fromYear: from.year, fromMonth: { gt: from.month } }],
      },
      orderBy: [{ fromYear: 'asc' }, { fromMonth: 'asc' }],
    });
    return next && { year: next.fromYear, month: next.fromMonth };
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
    const owner = u.siteId ?? u.firmId!;
    if (seen.has(owner)) return false;
    seen.add(owner);
    return true;
  });
}

function unique<T extends { id: string; name: string }>(rows: readonly T[]): T[] {
  return [...new Map(rows.map((r) => [r.id, r])).values()].sort((x, y) => x.name.localeCompare(y.name));
}

/** A version of the company default rule set, which always has a rounding step. */
function defaultRules(row: RulesRow): PayRules {
  const rules = toPayRules(row);
  if (rules.payRoundingStep === null) throw new Error(`Rules ${row.id} of a company default rule set have no rounding step`);
  return { ...rules, payRoundingStep: rules.payRoundingStep };
}

function toPayRules(row: RulesRow): StoredPayRules {
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
    payRoundingStep: row.payRoundingStep?.toString() ?? null,
  };
}

function toColumns(rules: StoredPayRules) {
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
    payRoundingStep: rules.payRoundingStep,
  };
}
