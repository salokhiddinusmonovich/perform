import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type LoginInput } from '@puantaj/schemas';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { AuthLayout } from '@/app/auth-layout';
import { Field, fieldControlProps, FormActions, FormError } from '@/components/form';
import { LoadingState } from '@/components/loading-state';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useMe, useResetSession } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';

/** Only same-site paths are allowed after login, never another site. */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const me = useMe();
  const resetSession = useResetSession();
  const [formError, setFormError] = useState<string>();

  useEffect(() => {
    document.title = `${t('login.title')} · ${t('app.name')}`;
  }, [t]);

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { identifier: '', password: '' },
  });
  const { errors } = form.formState;

  const login = useMutation({
    mutationFn: (values: LoginInput) => api.post('/auth/login', values),
    onSuccess: async () => {
      await resetSession();
      navigate(next, { replace: true });
    },
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
      form.resetField('password');
    },
  });

  if (me.isPending) return <LoadingState />;
  if (me.data) return <Navigate to={next} replace />;

  return (
    <AuthLayout>
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl">{t('login.title')}</h1>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            noValidate
            onSubmit={form.handleSubmit((values) => {
              setFormError(undefined);
              login.mutate(values);
            })}
          >
            <FormError message={formError} />
            <Field id="identifier" label={t('login.identifier')} error={errors.identifier} hint={t('login.identifierHint')}>
              <Input
                {...fieldControlProps('identifier', errors.identifier)}
                {...form.register('identifier')}
                autoComplete="username"
                inputMode="email"
                autoCapitalize="none"
                autoFocus
              />
            </Field>
            <Field id="password" label={t('login.password')} error={errors.password}>
              <Input
                {...fieldControlProps('password', errors.password)}
                {...form.register('password')}
                type="password"
                autoComplete="current-password"
              />
            </Field>
            <FormActions submitLabel={t('login.submit')} pending={login.isPending} fullWidth />
          </form>
        </CardContent>
      </Card>
      <p className="mt-4 text-center text-sm text-muted-foreground">{t('login.forgotHint')}</p>
    </AuthLayout>
  );
}
