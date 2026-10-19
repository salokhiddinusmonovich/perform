import { zodResolver } from '@hookform/resolvers/zod';
import { companySettingsSchema, type CompanySettingsInput } from '@puantaj/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ErrorState } from '@/components/error-state';
import { Field, fieldControlProps, FormActions } from '@/components/form';
import { LoadingState } from '@/components/loading-state';
import { PageHeader } from '@/components/page-header';
import { RequireAccess } from '@/components/require-access';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { isLanguage } from '@/i18n';
import { api } from '@/lib/api';
import { canManageCompany, ME_KEY } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { localeOf } from '@/lib/format';

const COMPANY_KEY = ['company', 'settings'] as const;
const CURRENCIES = ['UZS', 'USD', 'EUR', 'TRY', 'RUB', 'KZT'];
const TIMEZONES = ['Asia/Tashkent', 'Asia/Samarkand', 'Asia/Almaty', 'Asia/Dubai', 'Europe/Istanbul', 'Europe/Moscow'];

export function CompanySettingsPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('company.title')} description={t('company.description')} />
      <RequireAccess allowed={canManageCompany}>{() => <CompanySettingsForm />}</RequireAccess>
    </>
  );
}

function CompanySettingsForm() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: COMPANY_KEY, queryFn: () => api.get<CompanySettingsInput>('/company') });

  const form = useForm<CompanySettingsInput>({
    resolver: zodResolver(companySettingsSchema),
    defaultValues: { name: '', currency: 'UZS', timezone: 'Asia/Tashkent' },
  });
  const { errors, isDirty } = form.formState;

  useEffect(() => {
    if (settings.data) form.reset(settings.data);
  }, [settings.data, form]);

  const currencyName = useMemo(() => {
    const names = new Intl.DisplayNames(localeOf(isLanguage(i18n.language) ? i18n.language : 'en'), { type: 'currency' });
    return (code: string) => `${code} · ${names.of(code) ?? code}`;
  }, [i18n.language]);

  const save = useMutation({
    mutationFn: (values: CompanySettingsInput) => api.patch('/company', values),
    onSuccess: async (_, values) => {
      toast.success(t('common.saved'));
      form.reset(values);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: COMPANY_KEY }),
        queryClient.invalidateQueries({ queryKey: ME_KEY }),
      ]);
    },
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) toast.error(errorMessage(t, error));
    },
  });

  if (settings.isPending) return <LoadingState />;
  if (settings.isError) return <ErrorState onRetry={() => settings.refetch()} />;

  const withCurrent = (list: string[], current: string) => (list.includes(current) ? list : [current, ...list]);

  return (
    <Card className="max-w-2xl">
      <CardContent>
        <form className="space-y-4" noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))}>
          <Field id="name" label={t('company.name')} error={errors.name}>
            <Input {...fieldControlProps('name', errors.name)} {...form.register('name')} autoComplete="organization" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="currency" label={t('company.currency')} error={errors.currency} hint={t('company.currencyHint')}>
              <Controller
                control={form.control}
                name="currency"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="currency" className="w-full" aria-invalid={errors.currency ? true : undefined}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {withCurrent(CURRENCIES, field.value).map((code) => (
                        <SelectItem key={code} value={code}>
                          {currencyName(code)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
            <Field id="timezone" label={t('company.timezone')} error={errors.timezone} hint={t('company.timezoneHint')}>
              <Controller
                control={form.control}
                name="timezone"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="timezone" className="w-full" aria-invalid={errors.timezone ? true : undefined}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {withCurrent(TIMEZONES, field.value).map((zone) => (
                        <SelectItem key={zone} value={zone}>
                          {zone.replace('_', ' ')}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
          </div>
          <FormActions
            submitLabel={t('common.save')}
            pending={save.isPending}
            onCancel={isDirty ? () => form.reset() : undefined}
          />
        </form>
      </CardContent>
    </Card>
  );
}
