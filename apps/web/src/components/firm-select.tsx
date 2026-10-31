import { FIRM_TYPES } from '@puantaj/schemas';
import { useTranslation } from 'react-i18next';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { FirmItem } from '@/lib/organisation';

/**
 * Picks a firm of the company. Offers active firms, plus `keep` (the one already chosen)
 * even if it was closed since.
 */
export function FirmSelect({
  id,
  firms,
  value,
  onChange,
  keep,
  invalid,
}: {
  id: string;
  firms: readonly Pick<FirmItem, 'id' | 'name' | 'isActive'>[];
  /** A firm id, or '' for none yet */
  value: string;
  onChange: (value: string) => void;
  keep?: string | null;
  invalid?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full" aria-invalid={invalid ? true : undefined}>
        <SelectValue placeholder={t('firms.choose')} />
      </SelectTrigger>
      <SelectContent>
        {firms
          .filter((f) => f.isActive || f.id === keep || f.id === value)
          .map((f) => (
            <SelectItem key={f.id} value={f.id}>
              {f.name}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}

/** A firm filter: every firm, those with none yet, one type, or one firm. */
export type FirmFilterValue = 'all' | 'none' | (typeof FIRM_TYPES)[number] | (string & {});

/** Does a row in these firms (none: no firm yet) pass the filter? A worker who moved firms is in both. */
export function inFirmFilter(filter: FirmFilterValue, firms: readonly { id: string; type: string }[]): boolean {
  if (filter === 'all') return true;
  if (filter === 'none') return firms.length === 0;
  return firms.some((f) => f.id === filter || f.type === filter);
}

/** The firm filter of lists (workers, payroll), next to their other filters. */
export function FirmFilter({
  firms,
  value,
  onChange,
}: {
  firms: readonly Pick<FirmItem, 'id' | 'name'>[];
  value: FirmFilterValue;
  onChange: (value: FirmFilterValue) => void;
}) {
  const { t } = useTranslation();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full sm:w-56" aria-label={t('firms.firm')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{t('firms.all')}</SelectItem>
        <SelectItem value="none">{t('firms.none')}</SelectItem>
        {FIRM_TYPES.map((type) => (
          <SelectItem key={type} value={type}>
            {t(`firms.allOfType.${type}`)}
          </SelectItem>
        ))}
        {firms.map((f) => (
          <SelectItem key={f.id} value={f.id}>
            {f.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
