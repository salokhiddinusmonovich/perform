import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';

interface Health {
  status: 'ok';
  db: 'up';
  time: string;
}

export function DashboardPage() {
  const { t } = useTranslation();
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api.get<Health>('/health'),
    refetchInterval: 60_000,
    retry: false,
  });

  // The API is up if *it* answered, even with 503 { db: 'down' }. A 502/504 from the
  // proxy in front of it (nginx, Vite) means the API itself is down.
  const apiAnswered = health.isSuccess || isApiDbDownReply(health.error);
  const apiStatus: Status = health.isPending ? 'checking' : apiAnswered ? 'ok' : 'down';
  const dbStatus: Status = health.isPending ? 'checking' : health.isSuccess ? 'ok' : 'down';

  return (
    <>
      <PageHeader title={t('nav.dashboard')} description={t('dashboard.description')} />
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>{t('dashboard.systemStatus')}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            <StatusRow label={t('dashboard.api')} status={apiStatus} />
            <StatusRow label={t('dashboard.database')} status={dbStatus} />
          </dl>
        </CardContent>
      </Card>
    </>
  );
}

type Status = 'ok' | 'down' | 'checking';

function isApiDbDownReply(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 503 &&
    typeof error.body === 'object' &&
    error.body !== null &&
    (error.body as { db?: unknown }).db === 'down'
  );
}

function StatusRow({ label, status }: { label: string; status: Status }) {
  const { t } = useTranslation();
  const tone = status === 'ok' ? 'success' : status === 'down' ? 'danger' : 'neutral';
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 py-2">
      <dt className="text-sm">{label}</dt>
      <dd>
        <StatusBadge tone={tone}>{t(`status.${status}`)}</StatusBadge>
      </dd>
    </div>
  );
}
