import { zodResolver } from '@hookform/resolvers/zod';
import { changePasswordSchema } from '@puantaj/schemas';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { AuthLayout } from '@/app/auth-layout';
import { Field, fieldControlProps, FormActions, FormError } from '@/components/form';
import { LoadingState } from '@/components/loading-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { ME_KEY, useMe, useResetSession } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';

// Same rules as the API, plus "type it twice", which only the form needs.
const formSchema = changePasswordSchema.and(z.object({ confirmPassword: z.string() })).refine(
  (v) => v.confirmPassword === v.newPassword,
  { error: 'validation.passwordsDontMatch', path: ['confirmPassword'] },
);
type FormValues = z.input<typeof formSchema>;

/**
 * Used both voluntarily (from the user menu) and as the forced first step after
 * logging in with a temporary password.
 */
export function ChangePasswordPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const resetSession = useResetSession();
  const me = useMe();
  const [formError, setFormError] = useState<string>();

  useEffect(() => {
    document.title = `${t('changePassword.title')} · ${t('app.name')}`;
  }, [t]);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });
  const { errors } = form.formState;

  const change = useMutation({
    mutationFn: ({ currentPassword, newPassword }: FormValues) =>
      api.post('/auth/change-password', { currentPassword, newPassword }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
      toast.success(t('changePassword.done'));
      navigate('/', { replace: true });
    },
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  const logout = useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSettled: async () => {
      await navigate('/login', { replace: true });
      await resetSession();
    },
  });

  if (me.isPending) return <LoadingState />;
  if (!me.data) return <Navigate to="/login" replace />;
  const forced = me.data.user.mustChangePassword;

  return (
    <AuthLayout>
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl">{t('changePassword.title')}</h1>
          </CardTitle>
          <CardDescription>{forced ? t('changePassword.forcedHint') : t('changePassword.hint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            noValidate
            onSubmit={form.handleSubmit((values) => {
              setFormError(undefined);
              change.mutate(values);
            })}
          >
            <FormError message={formError} />
            <Field
              id="currentPassword"
              label={forced ? t('changePassword.temporary') : t('changePassword.current')}
              error={errors.currentPassword}
            >
              <Input
                {...fieldControlProps('currentPassword', errors.currentPassword)}
                {...form.register('currentPassword')}
                type="password"
                autoComplete="current-password"
                autoFocus
              />
            </Field>
            <Field id="newPassword" label={t('changePassword.new')} error={errors.newPassword} hint={t('changePassword.rules')}>
              <Input
                {...fieldControlProps('newPassword', errors.newPassword)}
                {...form.register('newPassword')}
                type="password"
                autoComplete="new-password"
              />
            </Field>
            <Field id="confirmPassword" label={t('changePassword.confirm')} error={errors.confirmPassword}>
              <Input
                {...fieldControlProps('confirmPassword', errors.confirmPassword)}
                {...form.register('confirmPassword')}
                type="password"
                autoComplete="new-password"
              />
            </Field>
            <FormActions
              submitLabel={t('changePassword.submit')}
              pending={change.isPending}
              onCancel={forced ? undefined : () => navigate(-1)}
            />
          </form>
        </CardContent>
      </Card>
      {forced && (
        <div className="mt-4 text-center">
          <Button variant="link" onClick={() => logout.mutate()} disabled={logout.isPending}>
            {t('nav.logout')}
          </Button>
        </div>
      )}
    </AuthLayout>
  );
}
