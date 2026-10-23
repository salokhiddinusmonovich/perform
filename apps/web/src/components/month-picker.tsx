import type { YearMonth } from '@puantaj/schemas';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useFormat } from '@/hooks/use-format';

interface MonthPickerProps {
  value: YearMonth;
  onChange: (value: YearMonth) => void;
  disabled?: boolean;
}

/** A month and a year, side by side, for things that start from a month (pay rules, salaries). */
export function MonthPicker({ value, onChange, disabled }: MonthPickerProps) {
  const { t } = useTranslation();
  const format = useFormat();
  // A few years around now, plus the chosen one if it is further away.
  const years = useMemo(() => {
    const now = new Date().getFullYear();
    const list = Array.from({ length: 6 }, (_, i) => now - 3 + i);
    return list.includes(value.year) ? list : [value.year, ...list].sort();
  }, [value.year]);

  return (
    <div className="grid max-w-md grid-cols-2 gap-2">
      <Select value={String(value.month)} onValueChange={(m) => onChange({ ...value, month: Number(m) })} disabled={disabled}>
        <SelectTrigger className="w-full" aria-label={t('common.month')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <SelectItem key={m} value={String(m)}>
              {format.monthName(m)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={String(value.year)} onValueChange={(y) => onChange({ ...value, year: Number(y) })} disabled={disabled}>
        <SelectTrigger className="w-full" aria-label={t('common.year')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {years.map((y) => (
            <SelectItem key={y} value={String(y)}>
              {y}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
