import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import { useWorkerCategories, type WorkerCategoryItem } from '@/lib/organisation';

export interface RuleSetItem {
  id: string;
  /** null: the company default */
  name: string | null;
  isActive: boolean;
  rulesFrom: { year: number; month: number } | null;
  usedBy: { sites: { id: string; name: string }[]; firms: { id: string; name: string }[] };
}

export const RULE_SETS_KEY = ['rule-sets'] as const;

export function useRuleSets() {
  return useQuery({ queryKey: RULE_SETS_KEY, queryFn: () => api.get<RuleSetItem[]>('/rule-sets') });
}

/** The categories a set splits by from a month on (AGENTS.md: Rule sets split by categories); empty: no split. */
export interface RuleSetSplitItem {
  fromYear: number;
  fromMonth: number;
  categoryIds: string[];
  setBy: { fullName: string };
  setAt: string;
}

/** A combination of a split set: its own rules and working days, kept through its id. */
export interface RuleSetVariantItem {
  id: string;
  options: { categoryId: string; optionId: string }[];
  rulesFrom: { year: number; month: number } | null;
}

export function useRuleSetSplits(ruleSetId: string) {
  return useQuery({
    queryKey: [...RULE_SETS_KEY, ruleSetId, 'splits'],
    queryFn: () => api.get<RuleSetSplitItem[]>(`/rule-sets/${ruleSetId}/splits`),
  });
}

export function useRuleSetVariants(ruleSetId: string) {
  return useQuery({
    queryKey: [...RULE_SETS_KEY, ruleSetId, 'variants'],
    queryFn: () => api.get<RuleSetVariantItem[]>(`/rule-sets/${ruleSetId}/variants`),
  });
}

/** The name a rule set goes by: its own, or the company default's. */
export function useRuleSetLabel(ruleSetId: string | undefined): string {
  const { t } = useTranslation();
  const set = useRuleSets().data?.find((s) => s.id === ruleSetId);
  return set ? (set.name ?? t('ruleSetCategories.defaultName')) : '';
}

/** A combination's options by name, in the order given: "Direkt + Expat". */
export function combinationLabel(categories: readonly WorkerCategoryItem[], optionIds: readonly string[]): string {
  return optionIds.map((id) => categories.flatMap((c) => c.options).find((o) => o.id === id)?.name ?? '').join(' + ');
}

/** The label of a set's combination by its id, in the order of its categories by name; '' without one. */
export function useCombinationLabel(ruleSetId: string, variantId: string | undefined): string {
  const variants = useRuleSetVariants(ruleSetId);
  const categories = useWorkerCategories().data ?? [];
  const variant = variantId ? variants.data?.find((v) => v.id === variantId) : undefined;
  if (!variant) return '';
  const ordered = categories.flatMap((c) => variant.options.filter((o) => o.categoryId === c.id).map((o) => o.optionId));
  return combinationLabel(categories, ordered);
}
