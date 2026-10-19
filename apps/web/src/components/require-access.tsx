import { ShieldX } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { LoadingState } from '@/components/loading-state';
import { Button } from '@/components/ui/button';
import { useMe, type Me } from '@/lib/auth';

interface RequireAccessProps {
  allowed: (me: Me) => boolean;
  /** Rendered with the verified user, so pages don't need to re-check it. */
  children: (me: Me) => ReactNode;
}

/**
 * Shows the page only if `allowed(me)`; otherwise a friendly "no access" state.
 * This is for clarity only: the API enforces every permission on its own.
 */
export function RequireAccess({ allowed, children }: RequireAccessProps) {
  const { t } = useTranslation();
  const me = useMe();
  if (me.isPending) return <LoadingState />;
  if (me.isError) return <ErrorState onRetry={() => me.refetch()} />;
  if (me.data && allowed(me.data)) return <>{children(me.data)}</>;
  return (
    <EmptyState
      icon={ShieldX}
      title={t('access.deniedTitle')}
      description={t('access.deniedDescription')}
      action={
        <Button asChild variant="outline">
          <Link to="/">{t('notFound.goHome')}</Link>
        </Button>
      }
    />
  );
}
