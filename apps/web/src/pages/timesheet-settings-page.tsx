import { zodResolver } from '@hookform/resolvers/zod';
import {
  ENTRY_ROLES,
  timesheetSettingsSchema,
  type TimesheetSettings,
  type TimesheetSettingsInput,
} from '@puantaj/schemas';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ErrorState } from '@/components/error-state';
import { FormActions } from '@/components/form';
import { LoadingState } from '@/components/loading-state';
import { PageHeader } from '@/components/page-header';
import { RequireAccess } from '@/components/require-access';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useFormat } from '@/hooks/use-format';
import { api } from '@/lib/api';
import { canManageTimesheet } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { TIMESHEET_KEY, TIMESHEET_SETTINGS_KEY, useTimesheetSettings } from '@/lib/timesheet';

export function TimesheetSettingsPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('timesheetSettings.title')} description={t('timesheetSettings.description')} />
      <RequireAccess allowed={canManageTimesheet}>{() => <SettingsForm />}</RequireAccess>
    </>
  );
}

function SettingsForm() {
  const { t } = useTranslation();
  const format = useFormat();
  const queryClient = useQueryClient();
  const settings = useTimesheetSettings();
  const form = useForm<TimesheetSettingsInput, unknown, TimesheetSettings>({
    resolver: zodResolver(timesheetSettingsSchema),
    defaultValues: { entryRoles: [] },
  });
  const { errors, isDirty } = form.formState;

  useEffect(() => {
    if (settings.data) form.reset({ entryRoles: settings.data.entryRoles });
  }, [settings.data, form]);

  const save = useMutation({
    mutationFn: (values: TimesheetSettings) => api.put('/timesheet/settings', values),
    onSuccess: async (_, values) => {
      toast.success(t('common.saved'));
      form.reset(values);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: TIMESHEET_SETTINGS_KEY }),
        // Who may enter hours changes what the grid lets each row do.
        queryClient.invalidateQueries({ queryKey: TIMESHEET_KEY }),
      ]);
    },
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) toast.error(errorMessage(t, error));
    },
  });

  if (settings.isPending) return <LoadingState />;
  if (settings.isError) return <ErrorState onRetry={() => settings.refetch()} />;

  return (
    <Card className="max-w-2xl">
      <CardContent>
        <form className="space-y-4" noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))}>
          <Controller
            control={form.control}
            name="entryRoles"
            render={({ field }) => (
              <fieldset className="space-y-1.5" aria-describedby={errors.entryRoles ? 'entryRoles-error' : 'entryRoles-hint'}>
                <legend className="mb-1.5 text-sm font-medium">{t('timesheetSettings.entryRoles')}</legend>
                {ENTRY_ROLES.map((role) => (
                  <Label key={role} className="flex min-h-10 cursor-pointer items-center gap-2 font-normal">
                    <Checkbox
                      checked={field.value.includes(role)}
                      onCheckedChange={(checked) =>
                        field.onChange(checked ? [...field.value, role] : field.value.filter((r) => r !== role))
                      }
                    />
                    <span>
                      {t(`roles.${role}`)}
                      <span className="block text-sm text-muted-foreground">{t(`timesheetSettings.scope.${role}`)}</span>
                    </span>
                  </Label>
                ))}
                {errors.entryRoles?.message ? (
                  <p id="entryRoles-error" role="alert" className="text-sm text-destructive">
                    {t(errors.entryRoles.message)}
                  </p>
                ) : (
                  <p id="entryRoles-hint" className="text-sm text-muted-foreground">
                    {t('timesheetSettings.entryRolesHint')}
                  </p>
                )}
              </fieldset>
            )}
          />
          {settings.data.setBy && settings.data.setAt && (
            <p className="text-sm text-muted-foreground">
              {t('timesheetSettings.lastChanged', { name: settings.data.setBy.fullName, date: format.date(settings.data.setAt) })}
            </p>
          )}
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
