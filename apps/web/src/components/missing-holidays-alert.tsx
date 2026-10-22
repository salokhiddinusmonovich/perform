import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

interface MissingHolidaysAlertProps {
  year: number;
  /** Moving holidays not entered for the year (from the API). */
  missing: string[];
  /** Shows a link to the holidays page (for pages other than it). */
  linkToHolidays?: boolean;
}

/** Warns that a year's working days are wrong until its moving holidays are entered. */
export function MissingHolidaysAlert({ year, missing, linkToHolidays = false }: MissingHolidaysAlertProps) {
  const { t } = useTranslation();
  if (missing.length === 0) return null;
  return (
    <Alert variant="warning" className="mb-4">
      <TriangleAlert aria-hidden />
      <AlertTitle>{t('holidays.missingTitle', { year })}</AlertTitle>
      <AlertDescription>
        <p>
          {t('holidays.missingDescription', {
            names: missing.map((kind) => t(`holidays.kind.${kind}`)).join(', '),
          })}
        </p>
        {linkToHolidays && (
          <Link to="/settings/holidays" className="font-medium underline underline-offset-4">
            {t('holidays.goToHolidays')}
          </Link>
        )}
      </AlertDescription>
    </Alert>
  );
}
