import { zodResolver } from '@hookform/resolvers/zod';
import {
  CODE_STATUSES,
  GRID_CODE_STATUSES,
  timesheetCodesSchema,
  type CodeStatus,
  type TimesheetCodes,
  type TimesheetCodesInput,
} from '@puantaj/schemas';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect } from 'react';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ErrorState } from '@/components/error-state';
import { fieldControlProps, FormActions } from '@/components/form';
import { LoadingState } from '@/components/loading-state';
import { PageHeader } from '@/components/page-header';
import { RequireAccess } from '@/components/require-access';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { canManageCompany } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { TIMESHEET_CODES_KEY, useTimesheetCodes } from '@/lib/timesheet';

const isGridStatus = (status: CodeStatus) => (GRID_CODE_STATUSES as readonly CodeStatus[]).includes(status);

export function TimesheetCodesPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('codes.title')} description={t('codes.description')} />
      <RequireAccess allowed={canManageCompany}>{() => <CodesForm />}</RequireAccess>
    </>
  );
}

/** The company's codes as one list, saved together. */
function CodesForm() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const codes = useTimesheetCodes();
  const form = useForm<TimesheetCodesInput, unknown, TimesheetCodes>({
    resolver: zodResolver(timesheetCodesSchema),
    defaultValues: { codes: [] },
  });
  const rows = useFieldArray({ control: form.control, name: 'codes' });
  const { errors, isDirty } = form.formState;

  useEffect(() => {
    if (codes.data) form.reset({ codes: codes.data });
  }, [codes.data, form]);

  const save = useMutation({
    mutationFn: (values: TimesheetCodes) => api.put('/timesheet-codes', values),
    onSuccess: async () => {
      toast.success(t('common.saved'));
      await queryClient.invalidateQueries({ queryKey: TIMESHEET_CODES_KEY });
    },
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) toast.error(errorMessage(t, error));
    },
  });

  /** Shows `index` in the grid for its status, and no other code of that status. */
  const showInGrid = (index: number, status: CodeStatus) => {
    form.getValues('codes').forEach((c, i) => {
      if (c.status === status) form.setValue(`codes.${i}.inGrid`, i === index, { shouldDirty: true });
    });
  };

  /** A changed status: the code is shown in the grid if its new status has no shown code yet. */
  const changeStatus = (index: number, status: CodeStatus) => {
    form.setValue(`codes.${index}.status`, status, { shouldDirty: true });
    const taken = form.getValues('codes').some((c, i) => i !== index && c.status === status && c.inGrid);
    form.setValue(`codes.${index}.inGrid`, isGridStatus(status) && !taken, { shouldDirty: true });
  };

  const add = () => {
    const list = form.getValues('codes');
    // The first absence still without a code, as the likeliest next one.
    const status = GRID_CODE_STATUSES.find((s) => !list.some((c) => c.status === s)) ?? 'ABSENT';
    rows.append({ code: '', status, inGrid: !list.some((c) => c.status === status && c.inGrid) });
  };

  if (codes.isPending) return <LoadingState />;
  if (codes.isError) return <ErrorState onRetry={() => codes.refetch()} />;

  return (
    <Card className="max-w-3xl">
      <CardContent>
        <form className="space-y-4" noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))}>
          <p className="text-sm text-muted-foreground">{t('codes.hint')}</p>
          {rows.fields.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('codes.code')}</TableHead>
                    <TableHead>{t('codes.status')}</TableHead>
                    <TableHead>{t('codes.inGrid')}</TableHead>
                    <TableHead>
                      <span className="sr-only">{t('common.actions')}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.fields.map((row, index) => {
                    const id = `code-${index}`;
                    const rowErrors = errors.codes?.[index];
                    return (
                      <TableRow key={row.id} className="align-top">
                        <TableCell className="min-w-28">
                          <Input
                            {...fieldControlProps(id, rowErrors?.code)}
                            {...form.register(`codes.${index}.code`)}
                            aria-label={t('codes.code')}
                            autoComplete="off"
                            className="w-24"
                          />
                          {rowErrors?.code?.message && (
                            <p id={`${id}-error`} role="alert" className="mt-1 text-sm text-destructive">
                              {t(rowErrors.code.message)}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="min-w-48">
                          <Controller
                            control={form.control}
                            name={`codes.${index}.status`}
                            render={({ field }) => (
                              <Select value={field.value} onValueChange={(v) => changeStatus(index, v as CodeStatus)}>
                                <SelectTrigger className="w-full" aria-label={t('codes.status')}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {CODE_STATUSES.map((s) => (
                                    <SelectItem key={s} value={s}>
                                      {t(`codes.statuses.${s}`)}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                          />
                        </TableCell>
                        <TableCell className="min-w-36">
                          <Controller
                            control={form.control}
                            name={`codes.${index}.inGrid`}
                            render={({ field }) => {
                              const status = form.watch(`codes.${index}.status`);
                              return isGridStatus(status) ? (
                                <div className="flex min-h-10 items-center">
                                  <Checkbox
                                    checked={field.value}
                                    onCheckedChange={(checked) => checked === true && showInGrid(index, status)}
                                    aria-label={t('codes.inGridFor', { code: form.watch(`codes.${index}.code`) })}
                                    aria-invalid={rowErrors?.inGrid ? true : undefined}
                                  />
                                </div>
                              ) : (
                                <p className="flex min-h-10 items-center text-sm text-muted-foreground">{t('codes.importOnly')}</p>
                              );
                            }}
                          />
                          {rowErrors?.inGrid?.message && (
                            <p role="alert" className="text-sm text-destructive">
                              {t(rowErrors.inGrid.message)}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => rows.remove(index)}
                            aria-label={t('codes.remove', { code: form.watch(`codes.${index}.code`) })}
                          >
                            <Trash2 aria-hidden />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
          {(errors.codes?.root?.message ?? errors.codes?.message) && (
            <p role="alert" className="text-sm text-destructive">
              {t((errors.codes?.root?.message ?? errors.codes?.message)!)}
            </p>
          )}
          <Button type="button" variant="outline" onClick={add}>
            <Plus aria-hidden />
            {t('codes.add')}
          </Button>
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
