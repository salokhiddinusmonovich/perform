import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import { useWorkerCategories, type WorkerCategoryItem } from '@/lib/organisation';

export interface RuleSetItem {
  id: string;
  name: string;
  isActive: boolean;
  /** The first month one of its combinations has rules for */
  rulesFrom: { year: number; month: number } | null;
  /** The company, sites and firms using it now, or from a later month */
  usedBy: { company: boolean; sites: { id: string; name: string }[]; firms: { id: string; name: string }[] };
}

export const RULE_SETS_KEY = ['rule-sets'] as const;

export function useRuleSets() {
  return useQuery({ queryKey: RULE_SETS_KEY, queryFn: () => api.get<RuleSetItem[]>('/rule-sets') });
}

/** Something chosen from a month on, until the next one (pay categories, rounding, a rule set). */
export interface FromMonth {
  fromYear: number;
  fromMonth: number;
  setBy: { fullName: string };
  setAt: string;
}

/** The company's pay categories from a month on (AGENTS.md: Pay rule sets): one or two, in their order. */
export interface PayCategoriesItem extends FromMonth {
  categoryIds: string[];
}

export const PAY_CATEGORIES_KEY = ['pay-categories'] as const;

/** Newest first. */
export function usePayCategories() {
  return useQuery({ queryKey: PAY_CATEGORIES_KEY, queryFn: () => api.get<PayCategoriesItem[]>('/pay-categories') });
}

const monthIndex = (year: number, month: number) => year * 12 + month - 1;

/** Of rows newest first: the one in force in a month, and the ones that start later, oldest first. */
export function inForceAndLater<T extends { fromYear: number; fromMonth: number }>(
  newestFirst: readonly T[],
  { year, month }: { year: number; month: number },
): { inForce: T | undefined; later: T[] } {
  const now = monthIndex(year, month);
  return {
    inForce: newestFirst.find((r) => monthIndex(r.fromYear, r.fromMonth) <= now),
    later: newestFirst.filter((r) => monthIndex(r.fromYear, r.fromMonth) > now).reverse(),
  };
}

/** A combination of a rule set: its own rules and working days, kept through its id. */
export interface RuleSetVariantItem {
  id: string;
  options: { categoryId: string; optionId: string }[];
  rulesFrom: { year: number; month: number } | null;
}

export function useRuleSetVariants(ruleSetId: string) {
  return useQuery({
    queryKey: [...RULE_SETS_KEY, ruleSetId, 'variants'],
    queryFn: () => api.get<RuleSetVariantItem[]>(`/rule-sets/${ruleSetId}/variants`),
  });
}

/** A rule set's name, '' while it loads. */
export function useRuleSetLabel(ruleSetId: string | undefined): string {
  return useRuleSets().data?.find((s) => s.id === ruleSetId)?.name ?? '';
}

/** Who uses a rule set, by name: the company first, then its sites and firms. */
export function useUsedByLabel(set: RuleSetItem | undefined): string {
  const { t } = useTranslation();
  if (!set) return '';
  return [...(set.usedBy.company ? [t('ruleSets.company')] : []), ...[...set.usedBy.sites, ...set.usedBy.firms].map((x) => x.name)].join(', ');
}

/** A combination's options by name, in the order given: "Direkt + Expat". */
export function combinationLabel(categories: readonly WorkerCategoryItem[], optionIds: readonly string[]): string {
  return optionIds.map((id) => categories.flatMap((c) => c.options).find((o) => o.id === id)?.name ?? '').join(' + ');
}

/** A combination's option ids in the order of their categories by name, as every page shows a combination. */
export function orderedOptionIds(categories: readonly WorkerCategoryItem[], variant: RuleSetVariantItem): string[] {
  return categories.flatMap((c) => variant.options.filter((o) => o.categoryId === c.id).map((o) => o.optionId));
}

/** The label of a set's combination by its id; '' without one. */
export function useCombinationLabel(ruleSetId: string, variantId: string | undefined): string {
  const variants = useRuleSetVariants(ruleSetId);
  const categories = useWorkerCategories().data ?? [];
  const variant = variantId ? variants.data?.find((v) => v.id === variantId) : undefined;
  return variant ? combinationLabel(categories, orderedOptionIds(categories, variant)) : '';
}
