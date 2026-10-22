import { MAX_YEAR, MIN_YEAR } from '@puantaj/schemas';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

interface YearSwitcherProps {
  year: number;
  onChange: (year: number) => void;
}

/** Previous / current / next year, for pages that show one year at a time. */
export function YearSwitcher({ year, onChange }: YearSwitcherProps) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1" role="group" aria-label={t('common.year')}>
      <Button
        variant="outline"
        size="icon"
        onClick={() => onChange(year - 1)}
        disabled={year <= MIN_YEAR}
        aria-label={t('common.previousYear')}
      >
        <ChevronLeft aria-hidden />
      </Button>
      <span className="min-w-16 text-center font-medium tabular-nums" aria-live="polite">
        {year}
      </span>
      <Button
        variant="outline"
        size="icon"
        onClick={() => onChange(year + 1)}
        disabled={year >= MAX_YEAR}
        aria-label={t('common.nextYear')}
      >
        <ChevronRight aria-hidden />
      </Button>
    </div>
  );
}
