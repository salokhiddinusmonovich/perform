import { Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/hooks/use-format';
import type { FromMonth } from '@/lib/rule-sets';

/**
 * Choices that each apply from a month on until the next one (a rule set, pay categories, a
 * rounding step), newest first, with who made them. With onRemove, each can be removed.
 */
export function FromMonthList<T extends FromMonth>({
  items,
  label,
  empty,
  onRemove,
}: {
  items: readonly T[];
  label: (item: T) => ReactNode;
  empty: string;
  onRemove?: (item: T) => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="divide-y divide-border">
      {items.map((item) => (
        <li key={`${item.fromYear}-${item.fromMonth}`} className="flex items-center justify-between gap-3 py-2">
          <div className="min-w-0">
            <div className="font-medium">{label(item)}</div>
            <div className="text-sm text-muted-foreground">
              {t('ruleSets.fromMonth', { month: format.month(item.fromYear, item.fromMonth) })} · {item.setBy.fullName}
            </div>
          </div>
          {onRemove && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('ruleSets.removeUse', { month: format.month(item.fromYear, item.fromMonth) })}
              onClick={() => onRemove(item)}
            >
              <Trash2 aria-hidden />
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
