import { LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** Shown while a page or a non-table section loads. Tables use their own skeleton rows. */
export function LoadingState() {
  const { t } = useTranslation();
  return (
    <div role="status" className="flex items-center justify-center gap-2 px-4 py-12 text-sm text-muted-foreground">
      <LoaderCircle className="size-5 animate-spin" aria-hidden />
      {t('common.loading')}
    </div>
  );
}
