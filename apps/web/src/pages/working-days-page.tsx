import { zodResolver } from '@hookform/resolvers/zod';
import {
  workingDaysOverrideSchema,
  type WorkingDaysOverride,
  type WorkingDaysOverrideInput,
} from '@puantaj/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Pencil } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { DataTable } from '@/components/data-table';
import { Field, fieldControlProps, FormActions, FormError } from '@/components/form';
import { MissingHolidaysAlert } from '@/components/missing-holidays-alert';
import { PageHeader } from '@/components/page-header';
import { RequireAccess } from '@/components/require-access';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { YearSwitcher } from '@/components/year-switcher';
import { useFormat } from '@/hooks/use-format';
import { api } from '@/lib/api';
import { canViewPayRules } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { useFirms } from '@/lib/organisation';

interface Override {
  workingDays: number | null;
  reason: string | null;
  setBy: { fullName: string };
  setAt: string;
}

interface MonthRow {
  month: number;
  rulesFrom: { year: number; month: number } | null;
  calculated: number | null;
  override: number | null;
  effective: number | null;
  locked: boolean;
  history: Override[];
}

interface WorkingDaysYear {
  year: number;
  missingMovingHolidays: string[];
  months: MonthRow[];
}

const workingDaysKey = (year: number, firmId: string | null) => ['working-days', firmId, year] as const;

export function WorkingDaysPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('workingDays.title')} description={t('workingDays.description')} />
      <RequireAccess allowed={canViewPayRules}>{() => <WorkingDaysView />}</RequireAccess>
    </>
  );
}

/** The working days of a firm's own rules (AGENTS.md: Firms). */
export function FirmWorkingDaysPage() {
  const { t } = useTranslation();
  const { firmId } = useParams<{ firmId: string }>();
  const firm = useFirms().data?.find((f) => f.id === firmId);
  return (
    <>
      <PageHeader title={t('firms.workingDaysTitle', { name: firm?.name ?? '' })} description={t('firms.workingDaysDescription')} />
      <RequireAccess allowed={canViewPayRules}>{() => <WorkingDaysView firmId={firmId!} />}</RequireAccess>
    </>
  );
}

/** Working days of the company default rules, or with firmId of that firm's own. */
function WorkingDaysView({ firmId = null }: { firmId?: string | null }) {
  const { t } = useTranslation();
  const format = useFormat();
  const queryClient = useQueryClient();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [editing, setEditing] = useState<MonthRow | null>(null);
  const data = useQuery({
    queryKey: workingDaysKey(year, firmId),
    queryFn: () => api.get<WorkingDaysYear>(`${firmId ? `/firms/${firmId}` : ''}/working-days?year=${year}`),
  });

  const columns = useMemo<ColumnDef<MonthRow, unknown>[]>(
    () => [
      {
        accessorKey: 'month',
        header: t('common.month'),
        cell: ({ row }) => <span className="font-medium">{format.monthName(row.original.month)}</span>,
      },
      {
        accessorKey: 'calculated',
        header: t('workingDays.calculated'),
        enableSorting: false,
        cell: ({ row }) => row.original.calculated ?? '—',
      },
      {
        accessorKey: 'override',
        header: t('workingDays.override'),
        enableSorting: false,
        cell: ({ row }) => row.original.override ?? '—',
      },
      {
        accessorKey: 'effective',
        header: t('workingDays.effective'),
        enableSorting: false,
        cell: ({ row }) =>
          row.original.effective === null ? (
            <Link to={firmId ? `/firms/${firmId}/pay-rules` : '/settings/pay-rules'} className="text-sm text-muted-foreground underline underline-offset-4">
              {t('workingDays.noRules')}
            </Link>
          ) : (
            <span className="font-semibold">{row.original.effective}</span>
          ),
      },
      {
        id: 'status',
        header: t('workingDays.status'),
        enableSorting: false,
        cell: ({ row }) =>
          row.original.locked ? (
            <StatusBadge tone="neutral">{t('workingDays.locked')}</StatusBadge>
          ) : row.original.override !== null ? (
            <StatusBadge tone="info">{t('workingDays.overridden')}</StatusBadge>
          ) : null,
      },
      {
        id: 'lastChange',
        header: t('workingDays.lastChange'),
        enableSorting: false,
        cell: ({ row }) => {
          const last = row.original.history[0];
          return last ? (
            <div className="min-w-32">
              <div>{last.setBy.fullName}</div>
              <div className="text-sm text-muted-foreground">{format.date(last.setAt)}</div>
            </div>
          ) : (
            '—'
          );
        },
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{t('common.actions')}</span>,
        enableSorting: false,
        cell: ({ row }) =>
          row.original.effective !== null && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setEditing(row.original)}
              aria-label={t('workingDays.changeFor', { month: format.month(year, row.original.month) })}
            >
              <Pencil aria-hidden />
            </Button>
          ),
      },
    ],
    [t, format, year, firmId],
  );

  return (
    <>
      {data.data && <MissingHolidaysAlert year={year} missing={data.data.missingMovingHolidays} linkToHolidays />}
      <DataTable
        columns={columns}
        data={data.data?.months}
        isLoading={data.isPending}
        isError={data.isError}
        onRetry={() => data.refetch()}
        toolbar={<YearSwitcher year={year} onChange={setYear} />}
      />
      <OverrideDialog
        // A fresh form for each month opened
        key={editing ? `${year}-${editing.month}` : 'closed'}
        year={year}
        firmId={firmId}
        row={editing}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          toast.success(t('common.saved'));
          await queryClient.invalidateQueries({ queryKey: ['working-days'] });
        }}
      />
    </>
  );
}

function OverrideDialog({
  year,
  firmId,
  row,
  onClose,
  onSaved,
}: {
  year: number;
  firmId: string | null;
  row: MonthRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const [formError, setFormError] = useState<string>();
  const form = useForm<WorkingDaysOverrideInput, unknown, WorkingDaysOverride>({
    resolver: zodResolver(workingDaysOverrideSchema),
    defaultValues: { workingDays: row?.override ?? null, reason: '' },
  });
  const { errors } = form.formState;
  const useCalculated = form.watch('workingDays') === null;

  const save = useMutation({
    mutationFn: (values: WorkingDaysOverride) =>
      api.post(`${firmId ? `/firms/${firmId}` : ''}/working-days/${year}/${row!.month}`, values),
    onSuccess: onSaved,
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{row && t('workingDays.changeFor', { month: format.month(year, row.month) })}</DialogTitle>
          <DialogDescription>
            {row?.calculated !== null && row && t('workingDays.calculatedIs', { count: row.calculated })}
          </DialogDescription>
        </DialogHeader>
        {row?.locked ? (
          <p className="text-sm text-muted-foreground">{t('workingDays.lockedHint')}</p>
        ) : (
          <form
            className="space-y-4"
            noValidate
            onSubmit={form.handleSubmit((values) => {
              setFormError(undefined);
              save.mutate(values);
            })}
          >
            <FormError message={formError} />
            <Controller
              control={form.control}
              name="workingDays"
              render={({ field }) => (
                <div className="space-y-3">
                  <Label className="flex min-h-10 cursor-pointer items-center gap-2 font-normal">
                    <Checkbox
                      checked={field.value === null}
                      onCheckedChange={(checked) => field.onChange(checked ? null : (row?.calculated ?? null))}
                    />
                    {t('workingDays.useCalculated')}
                  </Label>
                  {!useCalculated && (
                    <Field id="wd-days" label={t('workingDays.workingDays')} error={errors.workingDays}>
                      <Input
                        {...fieldControlProps('wd-days', errors.workingDays)}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={31}
                        value={field.value ?? ''}
                        onChange={(e) => field.onChange(e.target.value === '' ? NaN : Number(e.target.value))}
                        className="max-w-32"
                      />
                    </Field>
                  )}
                </div>
              )}
            />
            <Field id="wd-reason" label={t('workingDays.reason')} error={errors.reason} hint={t('workingDays.reasonHint')}>
              <Input {...fieldControlProps('wd-reason', errors.reason)} {...form.register('reason')} autoComplete="off" />
            </Field>
            <FormActions submitLabel={t('common.save')} pending={save.isPending} onCancel={onClose} />
          </form>
        )}
        {row && row.history.length > 0 && (
          <section className="space-y-2 border-t pt-4">
            <h3 className="text-sm font-medium">{t('workingDays.history')}</h3>
            <ul className="space-y-2 text-sm">
              {row.history.map((o, i) => (
                <li key={i} className="flex flex-col gap-0.5">
                  <span>
                    {o.workingDays === null
                      ? t('workingDays.historyBackToCalculated')
                      : t('workingDays.historySet', { count: o.workingDays })}
                    {o.reason && <span className="text-muted-foreground"> · {o.reason}</span>}
                  </span>
                  <span className="text-muted-foreground">
                    {o.setBy.fullName} · {format.date(o.setAt)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}
