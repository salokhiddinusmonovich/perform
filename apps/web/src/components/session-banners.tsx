import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Lock, TriangleAlert, UserCog } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/hooks/use-format';
import { api } from '@/lib/api';
import { ME_KEY, useResetSession, type Me } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';

/**
 * Shown on every page while a platform admin is logged in as someone else: whose account
 * it is, that every action is recorded under both names, and a button to stop.
 */
export function ImpersonationBanner({ me }: { me: Me }) {
  const { t } = useTranslation();
  const format = useFormat();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const resetSession = useResetSession();
  const impersonation = me.impersonation;

  // The API ends it by itself after the hour; reload then so the page shows the admin again.
  useEffect(() => {
    if (!impersonation) return;
    const ms = new Date(impersonation.endsAt).getTime() - Date.now();
    const timer = window.setTimeout(() => queryClient.invalidateQueries({ queryKey: ME_KEY }), Math.max(ms, 0) + 1000);
    return () => window.clearTimeout(timer);
  }, [impersonation, queryClient]);

  const end = useMutation({
    mutationFn: () => api.post('/auth/impersonation/end'),
    onSuccess: async () => {
      await resetSession();
      await navigate('/platform/users', { replace: true });
    },
    onError: (error) => toast.error(errorMessage(t, error)),
  });

  if (!impersonation) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-warning px-4 py-2 text-sm text-warning-foreground">
      <UserCog className="size-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        <span className="font-medium">{t('impersonation.banner', { name: me.user.fullName })}</span>{' '}
        {t('impersonation.bannerDetails', { by: impersonation.by, time: format.time(impersonation.endsAt) })}
      </p>
      <Button variant="outline" onClick={() => end.mutate()} disabled={end.isPending}>
        {t('impersonation.end')}
      </Button>
    </div>
  );
}

/**
 * The company's unpaid subscription: owners are warned during the grace period; after
 * it everyone sees that the company is read-only (AGENTS.md: Subscriptions).
 */
export function SubscriptionBanner({ me }: { me: Me }) {
  const { t } = useTranslation();
  const format = useFormat();
  const company = me.activeCompany;
  if (!company) return null;
  const { status, paidUntil, graceEndsOn } = company.subscription;

  if (status === 'GRACE' && company.role === 'OWNER' && paidUntil && graceEndsOn) {
    return (
      <Alert variant="warning" className="mb-4">
        <TriangleAlert aria-hidden />
        <AlertTitle>{t('subscription.graceTitle', { date: format.date(paidUntil) })}</AlertTitle>
        <AlertDescription>{t('subscription.graceDescription', { date: format.date(graceEndsOn) })}</AlertDescription>
      </Alert>
    );
  }
  if (status === 'READ_ONLY') {
    return (
      <Alert variant="destructive" className="mb-4">
        <Lock aria-hidden />
        <AlertTitle>{t('subscription.readOnlyTitle')}</AlertTitle>
        <AlertDescription>
          {company.role === 'OWNER' ? t('subscription.readOnlyOwner') : t('subscription.readOnlyMember')}
        </AlertDescription>
      </Alert>
    );
  }
  return null;
}
