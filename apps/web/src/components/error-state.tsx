import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

interface ErrorStateProps {
  /** Overrides the generic "could not load" text when the cause is known. */
  description?: string;
  onRetry?: () => void;
}

/** Shown when data fails to load. Every data view uses this, never ad-hoc text. */
export function ErrorState({ description, onRetry }: ErrorStateProps) {
  const { t } = useTranslation();

  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
        <TriangleAlert className="size-6 text-destructive" aria-hidden />
      </div>
      <div className="max-w-sm">
        <p className="font-medium">{t('states.errorTitle')}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {description ?? t('states.errorDescription')}
        </p>
      </div>
      {onRetry && (
        <Button variant="outline" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  );
}
