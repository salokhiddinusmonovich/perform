import { zodResolver } from '@hookform/resolvers/zod';
import {
  ADJUSTMENT_TYPES,
  adjustmentSchema,
  cancelAdjustmentSchema,
  type Adjustment,
  type AdjustmentInput,
  type CancelAdjustment,
  type CancelAdjustmentInput,
  type YearMonth,
} from '@puantaj/schemas';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Ban, FileText, Pencil } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { DataTable } from '@/components/data-table';
import { DepartmentFilter, inDepartmentFilter, type DepartmentFilterValue } from '@/components/department-select';
import { Field, fieldControlProps, FormActions, FormError } from '@/components/form';
import { ALL_SITES, SiteFilter } from '@/components/list-filters';
import { MonthSwitcher } from '@/components/month-switcher';
import { PageHeader } from '@/components/page-header';
import { RequireAccess } from '@/components/require-access';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useFormat } from '@/hooks/use-format';
import { api } from '@/lib/api';
import { canAddAdjustments, seesPay, usesDepartments, type Me } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { useDepartments, workerName, workerSearchText } from '@/lib/organisation';
import {
  ADJUSTMENTS_KEY,
  currentMonth,
  matchesAdjustmentFilter,
  PAYROLL_KEY,
  siteChoices,
  useAdjustments,
  type AdjustmentFilterValue,
  type AdjustmentItem,
  type AdjustmentsRow,
} from '@/lib/payroll';

export function AdjustmentsPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('adjustments.title')} description={t('adjustments.description')} />
      <RequireAccess allowed={seesPay}>{(me) => <AdjustmentsView me={me} />}</RequireAccess>
    </>
  );
}

function AdjustmentsView({ me }: { me: Me }) {
  const { t } = useTranslation();
  const format = useFormat();
  const queryClient = useQueryClient();
  const currency = me.activeCompany!.currency;
  const canAdd = canAddAdjustments(me);
  const [month, setMonth] = useState<YearMonth>(currentMonth);
  const [openId, setOpenId] = useState<string | null>(null);
  const data = useAdjustments(month);
  const locked = data.data?.locked ?? false;
  // The open row follows the data, so the dialog shows an adjustment as soon as it's saved.
  const open = data.data?.rows.find((r) => r.worker.id === openId) ?? null;
  const showDepartments = usesDepartments(me);
  const departments = useDepartments({ enabled: showDepartments });
  const [chosenSite, setSiteFilter] = useState(ALL_SITES);
  const [departmentFilter, setDepartmentFilter] = useState<DepartmentFilterValue>('all');
  const [adjustmentFilter, setAdjustmentFilter] = useState<AdjustmentFilterValue>('all');
  const sites = useMemo(() => siteChoices(data.data?.rows.flatMap((r) => r.siteNames) ?? []), [data.data]);
  // A site without workers in the month on screen falls back to every site.
  const siteFilter = sites.some((s) => s.value === chosenSite) ? chosenSite : ALL_SITES;
  const rows = useMemo(
    () =>
      data.data?.rows.filter(
        (r) =>
          (siteFilter === ALL_SITES || r.siteNames.includes(siteFilter)) &&
          (!showDepartments || inDepartmentFilter(departmentFilter, r.departmentId, departments.data ?? [])) &&
          matchesAdjustmentFilter(adjustmentFilter, r.adjustments),
      ),
    [data.data, siteFilter, showDepartments, departmentFilter, departments.data, adjustmentFilter],
  );

  const columns = useMemo<ColumnDef<AdjustmentsRow, unknown>[]>(
    () => [
      {
        id: 'name',
        accessorFn: (r) => workerName(r.worker),
        header: t('workers.name'),
        cell: ({ row }) => (
          <div className="min-w-44">
            <div className="font-medium">{workerName(row.original.worker)}</div>
            {row.original.worker.position && (
              <div className="text-sm text-muted-foreground">{row.original.worker.position}</div>
            )}
          </div>
        ),
      },
      {
        id: 'sites',
        accessorFn: (r) => r.siteNames.join(', '),
        header: t('workers.site'),
        cell: ({ row }) => <div className="min-w-36">{row.original.siteNames.join(', ')}</div>,
      },
      {
        id: 'adjustments',
        header: t('adjustments.entries'),
        enableSorting: false,
        cell: ({ row }) => <AdjustmentsSummary items={row.original.adjustments} />,
      },
      {
        id: 'net',
        accessorFn: (r) => Number(r.net),
        header: t('adjustments.net'),
        cell: ({ row }) =>
          row.original.adjustments.some((a) => !a.cancelled) ? (
            <span className="font-semibold tabular-nums">{format.signedMoney(row.original.net, currency)}</span>
          ) : (
            '—'
          ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{t('common.actions')}</span>,
        enableSorting: false,
        cell: ({ row }) => {
          const name = workerName(row.original.worker);
          const editable = canAdd && !locked;
          return (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setOpenId(row.original.worker.id)}
              aria-label={t(editable ? 'adjustments.editFor' : 'adjustments.viewFor', { name })}
            >
              {editable ? <Pencil aria-hidden /> : <FileText aria-hidden />}
            </Button>
          );
        },
      },
    ],
    [t, format, currency, canAdd, locked],
  );

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ADJUSTMENTS_KEY }),
      queryClient.invalidateQueries({ queryKey: PAYROLL_KEY }),
    ]);

  return (
    <>
      <DataTable
        columns={columns}
        data={rows}
        isLoading={data.isPending}
        isError={data.isError}
        onRetry={() => data.refetch()}
        totalCount={data.data?.rows.length}
        searchable
        searchText={(r) => `${workerSearchText(r.worker)} ${r.siteNames.join(' ')}`}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <MonthSwitcher value={month} onChange={setMonth} />
            <SiteFilter sites={sites} value={siteFilter} onChange={setSiteFilter} />
            {showDepartments && (
              <DepartmentFilter departments={departments.data ?? []} value={departmentFilter} onChange={setDepartmentFilter} />
            )}
            <Select value={adjustmentFilter} onValueChange={(v) => setAdjustmentFilter(v as AdjustmentFilterValue)}>
              <SelectTrigger className="w-full sm:w-48" aria-label={t('adjustments.entries')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('adjustments.filterAll')}</SelectItem>
                <SelectItem value="any">{t('adjustments.filterAny')}</SelectItem>
                {ADJUSTMENT_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {t(`adjustments.types.${type}`)}
                  </SelectItem>
                ))}
                <SelectItem value="cancelled">{t('adjustments.filterCancelled')}</SelectItem>
              </SelectContent>
            </Select>
            {locked && <StatusBadge tone="neutral">{t('monthlyHours.locked')}</StatusBadge>}
          </div>
        }
        emptyTitle={t('adjustments.emptyTitle')}
        emptyDescription={t('adjustments.emptyDescription')}
      />
      {open && (
        <WorkerAdjustmentsDialog
          key={open.worker.id}
          month={month}
          row={open}
          currency={currency}
          editable={canAdd && !locked}
          locked={locked}
          onClose={() => setOpenId(null)}
          onChanged={refresh}
        />
      )}
    </>
  );
}

/** "Bonus · Advance" for the adjustments that count, leaving out cancelled ones. */
function AdjustmentsSummary({ items }: { items: AdjustmentItem[] }) {
  const { t } = useTranslation();
  const counting = items.filter((a) => !a.cancelled);
  if (counting.length === 0) return <span className="text-sm text-muted-foreground">{t('adjustments.none')}</span>;
  return <span className="text-sm">{counting.map((a) => t(`adjustments.types.${a.type}`)).join(' · ')}</span>;
}


/** A worker's adjustments for the month: add one, see them all, cancel a mistake. */
function WorkerAdjustmentsDialog({
  month,
  row,
  currency,
  editable,
  locked,
  onClose,
  onChanged,
}: {
  month: YearMonth;
  row: AdjustmentsRow;
  currency: string;
  editable: boolean;
  locked: boolean;
  onClose: () => void;
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const [formError, setFormError] = useState<string>();
  const [cancelling, setCancelling] = useState<AdjustmentItem | null>(null);
  const form = useForm<AdjustmentInput, unknown, Adjustment>({
    resolver: zodResolver(adjustmentSchema),
    defaultValues: { amount: '', note: '' },
  });
  const { errors } = form.formState;

  const save = useMutation({
    mutationFn: (values: Adjustment) => api.post(`/adjustments/${month.year}/${month.month}/${row.worker.id}`, values),
    onSuccess: async (_, values) => {
      toast.success(t('adjustments.added'));
      // Ready for the next one of the same type.
      form.reset({ type: values.type, amount: '', note: '' });
      await onChanged();
    },
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('adjustments.dialogTitle', { month: format.month(month.year, month.month) })}</DialogTitle>
          <DialogDescription>
            {workerName(row.worker)} · {row.siteNames.join(', ')}
          </DialogDescription>
        </DialogHeader>
        {editable ? (
          <form
            className="space-y-4"
            noValidate
            onSubmit={form.handleSubmit((values) => {
              setFormError(undefined);
              save.mutate(values);
            })}
          >
            <FormError message={formError} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Controller
                control={form.control}
                name="type"
                render={({ field }) => (
                  <Field id="adj-type" label={t('adjustments.type')} error={errors.type}>
                    <Select value={field.value ?? ''} onValueChange={field.onChange}>
                      <SelectTrigger id="adj-type" className="w-full" aria-invalid={errors.type ? true : undefined}>
                        <SelectValue placeholder={t('adjustments.chooseType')} />
                      </SelectTrigger>
                      <SelectContent>
                        {ADJUSTMENT_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {t(`adjustments.types.${type}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              />
              <Field id="adj-amount" label={t('adjustments.amount', { currency })} error={errors.amount}>
                <Input {...fieldControlProps('adj-amount', errors.amount)} {...form.register('amount')} inputMode="decimal" autoComplete="off" />
              </Field>
            </div>
            <Field id="adj-note" label={t('monthlyHours.note')} error={errors.note} hint={t('adjustments.noteHint')}>
              <Input {...fieldControlProps('adj-note', errors.note)} {...form.register('note')} autoComplete="off" />
            </Field>
            <p className="text-sm text-muted-foreground">{t('adjustments.addHint')}</p>
            <FormActions submitLabel={t('adjustments.add')} pending={save.isPending} onCancel={onClose} />
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">{locked ? t('adjustments.lockedHint') : t('adjustments.viewOnlyHint')}</p>
        )}
        <section className="space-y-2 border-t pt-4">
          <h3 className="text-sm font-medium">{t('adjustments.thisMonth')}</h3>
          {row.adjustments.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('adjustments.none')}</p>
          ) : (
            <ul className="divide-y rounded-md border text-sm">
              {row.adjustments.map((a) => (
                <li key={a.id} className="flex items-start justify-between gap-4 px-3 py-2">
                  <span className="flex flex-col gap-0.5">
                    <span className={a.cancelled ? 'text-muted-foreground line-through' : 'font-medium'}>
                      {t(`adjustments.types.${a.type}`)}
                    </span>
                    {a.note && <span className="text-muted-foreground">{a.note}</span>}
                    <span className="text-muted-foreground">
                      {a.setBy.fullName} · {format.date(a.setAt)}
                    </span>
                    {a.cancelled && (
                      <span className="flex flex-wrap items-center gap-2">
                        <StatusBadge tone="neutral">{t('adjustments.cancelled')}</StatusBadge>
                        <span className="text-muted-foreground">
                          {a.cancelled.by.fullName} · {format.date(a.cancelled.at)} · {a.cancelled.reason}
                        </span>
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <span className={a.cancelled ? 'tabular-nums text-muted-foreground line-through' : 'tabular-nums'}>
                      {format.signedMoney(a.signedAmount, currency)}
                    </span>
                    {editable && !a.cancelled && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setCancelling(a)}
                        aria-label={t('adjustments.cancelFor', { type: t(`adjustments.types.${a.type}`) })}
                      >
                        <Ban aria-hidden />
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        {cancelling && (
          <CancelDialog
            adjustment={cancelling}
            worker={workerName(row.worker)}
            currency={currency}
            onClose={() => setCancelling(null)}
            onSaved={async () => {
              setCancelling(null);
              toast.success(t('adjustments.cancelledToast'));
              await onChanged();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Cancelling names what is affected and needs a reason, which goes into the audit log. */
function CancelDialog({
  adjustment,
  worker,
  currency,
  onClose,
  onSaved,
}: {
  adjustment: AdjustmentItem;
  worker: string;
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const [formError, setFormError] = useState<string>();
  const form = useForm<CancelAdjustmentInput, unknown, CancelAdjustment>({
    resolver: zodResolver(cancelAdjustmentSchema),
    defaultValues: { reason: '' },
  });
  const save = useMutation({
    mutationFn: (values: CancelAdjustment) => api.post(`/adjustments/${adjustment.id}/cancel`, values),
    onSuccess: onSaved,
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });
  const error = form.formState.errors.reason;
  return (
    <Dialog open onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('adjustments.cancelTitle', {
              type: t(`adjustments.types.${adjustment.type}`),
              amount: format.money(adjustment.amount, currency),
              name: worker,
            })}
          </DialogTitle>
          <DialogDescription>{t('adjustments.cancelHint')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={form.handleSubmit((values) => {
            setFormError(undefined);
            save.mutate(values);
          })}
        >
          <FormError message={formError} />
          <Field id="adj-cancel-reason" label={t('adjustments.cancelReason')} error={error}>
            <Input {...fieldControlProps('adj-cancel-reason', error)} {...form.register('reason')} autoComplete="off" />
          </Field>
          <FormActions submitLabel={t('adjustments.cancelSubmit')} pending={save.isPending} onCancel={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
