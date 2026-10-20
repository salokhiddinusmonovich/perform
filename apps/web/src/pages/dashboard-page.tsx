import type { Role } from '@puantaj/schemas';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useFormat } from '@/hooks/use-format';
import { api, ApiError } from '@/lib/api';
import { useResetSession } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';

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
      <div className="flex max-w-xl flex-col gap-6">
        <InvitationsCard />
        <Card>
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
      </div>
    </>
  );
}

interface Invitation {
  companyId: string;
  companyName: string;
  role: Role;
  invitedAt: string;
}

const INVITATIONS_KEY = ['invitations'] as const;

/** Companies that invited the logged-in person (shown only when there are some). */
function InvitationsCard() {
  const { t } = useTranslation();
  const format = useFormat();
  const resetSession = useResetSession();
  const invitations = useQuery({ queryKey: INVITATIONS_KEY, queryFn: () => api.get<Invitation[]>('/invitations') });
  const [declining, setDeclining] = useState<Invitation | null>(null);

  const accept = useMutation({
    mutationFn: (invitation: Invitation) => api.post(`/invitations/${invitation.companyId}/accept`),
    onSuccess: async (_, invitation) => {
      toast.success(t('invitations.accepted', { company: invitation.companyName }));
      // The person's list of companies changed.
      await resetSession();
    },
    onError: (error) => toast.error(errorMessage(t, error)),
  });

  async function decline() {
    if (!declining) return;
    await api.post(`/invitations/${declining.companyId}/decline`);
    toast.success(t('invitations.declined'));
    await invitations.refetch();
  }

  if (!invitations.data?.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('invitations.title')}</CardTitle>
        <CardDescription>{t('invitations.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {invitations.data.map((invitation) => (
            <li key={invitation.companyId} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <div className="font-medium">{invitation.companyName}</div>
                <div className="text-sm text-muted-foreground">
                  {t('invitations.details', {
                    role: t(`roles.${invitation.role}`),
                    date: format.date(invitation.invitedAt),
                  })}
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  aria-label={t('invitations.declineFor', { company: invitation.companyName })}
                  disabled={accept.isPending}
                  onClick={() => setDeclining(invitation)}
                >
                  {t('invitations.decline')}
                </Button>
                <Button
                  aria-label={t('invitations.acceptFor', { company: invitation.companyName })}
                  disabled={accept.isPending}
                  onClick={() => accept.mutate(invitation)}
                >
                  {t('invitations.accept')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
      <ConfirmDialog
        open={declining !== null}
        onOpenChange={(open) => !open && setDeclining(null)}
        title={t('invitations.confirmDecline.title')}
        description={declining ? t('invitations.confirmDecline.description', { company: declining.companyName }) : ''}
        confirmLabel={t('invitations.confirmDecline.button')}
        destructive
        onConfirm={decline}
      />
    </Card>
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
