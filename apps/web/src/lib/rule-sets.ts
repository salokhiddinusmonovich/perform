import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

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
