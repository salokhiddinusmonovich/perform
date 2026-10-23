import { MAX_YEAR, MIN_YEAR, type YearMonth } from '@puantaj/schemas';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/hooks/use-format';

interface MonthSwitcherProps {
  value: YearMonth;
  onChange: (value: YearMonth) => void;
}

const shift = ({ year, month }: YearMonth, by: number): YearMonth => {
  const index = year * 12 + month - 1 + by;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
};

/** Previous / current / next month, for pages that show one month at a time. */
export function MonthSwitcher({ value, onChange }: MonthSwitcherProps) {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <div className="flex items-center gap-1" role="group" aria-label={t('common.month')}>
      <Button
        variant="outline"
        size="icon"
        onClick={() => onChange(shift(value, -1))}
        disabled={value.year <= MIN_YEAR && value.month === 1}
        aria-label={t('common.previousMonth')}
      >
        <ChevronLeft aria-hidden />
      </Button>
      <span className="min-w-36 text-center font-medium" aria-live="polite">
        {format.month(value.year, value.month)}
      </span>
      <Button
        variant="outline"
        size="icon"
        onClick={() => onChange(shift(value, 1))}
        disabled={value.year >= MAX_YEAR && value.month === 12}
        aria-label={t('common.nextMonth')}
      >
        <ChevronRight aria-hidden />
      </Button>
    </div>
  );
}
