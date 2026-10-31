import { zodResolver } from '@hookform/resolvers/zod';
import { companySettingsSchema, type CompanySettingsInput } from '@puantaj/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ErrorState } from '@/components/error-state';
import { Field, fieldControlProps, FormActions } from '@/components/form';
import { LoadingState } from '@/components/loading-state';
import { PageHeader } from '@/components/page-header';
import { RequireAccess } from '@/components/require-access';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { isLanguage } from '@/i18n';
import { api } from '@/lib/api';
import { canManageCompany, ME_KEY, usesDepartments, usesFirms, type Me } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { localeOf, today } from '@/lib/format';
import { stillPlaced, useDepartments, useFirms, useWorkers } from '@/lib/organisation';

const COMPANY_KEY = ['company', 'settings'] as const;
const CURRENCIES = ['UZS', 'USD', 'EUR', 'TRY', 'RUB', 'KZT'];
const TIMEZONES = ['Asia/Tashkent', 'Asia/Samarkand', 'Asia/Almaty', 'Asia/Dubai', 'Europe/Istanbul', 'Europe/Moscow'];

export function CompanySettingsPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('company.title')} description={t('company.description')} />
      <RequireAccess allowed={canManageCompany}>
        {(me) => (
          <div className="space-y-6">
            <CompanySettingsForm />
            <DepartmentsSetting me={me} />
            <FirmsSetting me={me} />
          </div>
        )}
      </RequireAccess>
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

/**
 * Whether the company uses departments (AGENTS.md: Departments). It changes what every new placement
 * needs, so both ways are confirmed first. It needs an active department to switch on.
 */
function DepartmentsSetting({ me }: { me: Me }) {
  const departments = useDepartments();
  const workers = useWorkers();
  return (
    <ListSetting
      kind="departments"
      enabled={usesDepartments(me)}
      pending={departments.isPending}
      hasActive={(departments.data ?? []).some((d) => d.isActive)}
      missing={stillPlaced(workers.data ?? [], today()).filter((w) => !w.placement.departmentId).length}
    />
  );
}

/** Whether the company uses firms (AGENTS.md: Firms), like departments. It needs an active firm to switch on. */
function FirmsSetting({ me }: { me: Me }) {
  const firms = useFirms();
  const workers = useWorkers();
  return (
    <ListSetting
      kind="firms"
      enabled={usesFirms(me)}
      pending={firms.isPending}
      hasActive={(firms.data ?? []).some((f) => f.isActive)}
      missing={stillPlaced(workers.data ?? [], today()).filter((w) => !w.placement.firmId).length}
    />
  );
}

/** Switching on or off a list every new placement then needs. `kind` names its API route, page and translations. */
function ListSetting({
  kind,
  enabled,
  pending,
  hasActive,
  missing,
}: {
  kind: 'departments' | 'firms';
  enabled: boolean;
  pending: boolean;
  hasActive: boolean;
  /** Workers placed now without one */
  missing: number;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  return (
    <Card className="max-w-2xl">
      <CardContent className="space-y-3">
        <div className="flex items-start gap-3">
          <Checkbox
            id={`use-${kind}`}
            className="mt-0.5"
            checked={enabled}
            disabled={pending || (!enabled && !hasActive)}
            onCheckedChange={() => setConfirming(true)}
          />
          <div className="space-y-1">
            <Label htmlFor={`use-${kind}`} className="cursor-pointer">
              {t(`${kind}.use`)}
            </Label>
            <p className="text-sm text-muted-foreground">{t(`${kind}.useHint`)}</p>
            {!enabled && !pending && !hasActive && (
              <p className="text-sm text-muted-foreground">{t(`${kind}.useNeedsOne`)}</p>
            )}
            <Link to={`/${kind}`} className="inline-flex min-h-10 items-center text-sm underline underline-offset-4">
              {t(`${kind}.listLink`)}
            </Link>
          </div>
        </div>
      </CardContent>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={enabled ? t(`${kind}.confirmOff.title`) : t(`${kind}.confirmOn.title`)}
        description={
          enabled
            ? t(`${kind}.confirmOff.description`)
            : `${t(`${kind}.confirmOn.description`)}${missing > 0 ? ` ${t(`${kind}.confirmOn.missing`, { count: missing })}` : ''}`
        }
        confirmLabel={enabled ? t(`${kind}.switchOff`) : t(`${kind}.switchOn`)}
        onConfirm={async () => {
          await api.put(`/${kind}/settings`, { enabled: !enabled });
          toast.success(t('common.saved'));
          // Forms, lists and the menu show them by "me".
          await queryClient.invalidateQueries({ queryKey: ME_KEY });
        }}
      />
    </Card>
  );
}
