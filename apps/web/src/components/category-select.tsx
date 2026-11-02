import { useTranslation } from 'react-i18next';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { WorkerCategoryItem } from '@/lib/organisation';

/** "Not set" in a category's select and filter; can't be mistaken for an option's id. */
export const NOT_SET = 'not-set';

/**
 * Picks a worker's option in one category (AGENTS.md: Worker categories), or none. Offers
 * the active options, plus the one already chosen even if it was closed since.
 */
export function CategoryOptionSelect({
  id,
  category,
  value,
  onChange,
  invalid,
}: {
  id: string;
  category: WorkerCategoryItem;
  /** An option id, or null for none */
  value: string | null;
  onChange: (value: string | null) => void;
  invalid?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Select value={value ?? NOT_SET} onValueChange={(v) => onChange(v === NOT_SET ? null : v)}>
      <SelectTrigger id={id} className="w-full" aria-invalid={invalid ? true : undefined}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NOT_SET}>{t('workerCategories.notSet')}</SelectItem>
        {category.options
          .filter((o) => o.isActive || o.id === value)
          .map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.name}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}

/** A category filter: every worker, or those with one option (or none) in one category: "categoryId:optionId". */
export type CategoryFilterValue = 'all' | (string & {});

/** Does a row with these options (by category id) pass the filter? Rows without options saved (old locked months) only pass "all". */
export function inCategoryFilter(filter: CategoryFilterValue, values: Readonly<Record<string, string>> | undefined): boolean {
  if (filter === 'all') return true;
  if (!values) return false;
  const [categoryId, optionId] = filter.split(':');
  return (values[categoryId] ?? NOT_SET) === optionId;
}

/** The category filter of lists (workers, payroll): one select, its options grouped by category. */
export function CategoryFilter({
  categories,
  value,
  onChange,
}: {
  categories: readonly WorkerCategoryItem[];
  value: CategoryFilterValue;
  onChange: (value: CategoryFilterValue) => void;
}) {
  const { t } = useTranslation();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full sm:w-56" aria-label={t('workerCategories.filter')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{t('workerCategories.allWorkers')}</SelectItem>
        {categories.map((c) => (
          <SelectGroup key={c.id}>
            <SelectLabel>{c.name}</SelectLabel>
            {c.options.map((o) => (
              <SelectItem key={o.id} value={`${c.id}:${o.id}`}>
                {o.name}
              </SelectItem>
            ))}
            <SelectItem value={`${c.id}:${NOT_SET}`}>{t('workerCategories.notSetIn', { name: c.name })}</SelectItem>
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
