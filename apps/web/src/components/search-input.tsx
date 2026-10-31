import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';

/** The one search box, used by DataTable and the timesheet grid. */
export function SearchInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="relative w-full sm:max-w-xs sm:min-w-64 sm:flex-1">
      <Search
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('common.search')}
        aria-label={t('common.search')}
        className="pl-9"
      />
    </div>
  );
}
