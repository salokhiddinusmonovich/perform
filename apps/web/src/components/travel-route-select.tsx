import { useTranslation } from 'react-i18next';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useFormat } from '@/hooks/use-format';
import type { TravelRouteItem } from '@/lib/organisation';

/** Radix Select can't hold an empty value, so "no route" has its own. */
const NO_ROUTE = 'none';

/**
 * Picks a placement's travel route, or none. Offers active routes, plus `keep` (the one the
 * placement has) even if it was archived since.
 */
export function TravelRouteSelect({
  id,
  routes,
  value,
  onChange,
  keep,
  currency,
  invalid,
}: {
  id: string;
  routes: readonly TravelRouteItem[];
  /** A route id, or '' for none */
  value: string;
  onChange: (value: string) => void;
  keep?: string | null;
  currency: string;
  invalid?: boolean;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <Select value={value || NO_ROUTE} onValueChange={(v) => onChange(v === NO_ROUTE ? '' : v)}>
      <SelectTrigger id={id} className="w-full" aria-invalid={invalid ? true : undefined}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_ROUTE}>{t('workers.noTravelRoute')}</SelectItem>
        {routes
          .filter((r) => r.isActive || r.id === keep || r.id === value)
          .map((r) => (
            <SelectItem key={r.id} value={r.id}>
              {t('travelRoutes.withAmount', { name: r.name, amount: format.money(r.amountPerDay, currency) })}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}
