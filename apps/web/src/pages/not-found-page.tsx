import { SearchX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('notFound.title')} />
      <EmptyState
        icon={SearchX}
        title={t('notFound.description')}
        action={
          <Button asChild>
            <Link to="/">{t('notFound.goHome')}</Link>
          </Button>
        }
      />
    </>
  );
}
