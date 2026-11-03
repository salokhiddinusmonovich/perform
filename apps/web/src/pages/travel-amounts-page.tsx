import { zodResolver } from '@hookform/resolvers/zod';
import { travelAmountSchema, type TravelAmount, type TravelAmountInput, type YearMonth } from '@puantaj/schemas';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Pencil } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
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
import { useFormat } from '@/hooks/use-format';
import { api } from '@/lib/api';
import { canEnterMonthlyHours, usesDepartments, type Me } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { useDepartments, workerName, workerSearchText } from '@/lib/organisation';
import {
  currentMonth,
  monthDays,
  partDates,
  PAYROLL_KEY,
  siteChoices,
  TRAVEL_AMOUNTS_KEY,
  useTravelAmounts,
  type TravelAmountRow,
} from '@/lib/payroll';

type AmountStatus = 'entered' | 'notEntered' | 'notPaid' | 'noRules';
const STATUS_TONES = { entered: 'success', notEntered: 'warning', notPaid: 'neutral', noRules: 'warning' } as const;

function amountStatus(row: TravelAmountRow): AmountStatus {
  if (row.travelPayMode === null) return 'noRules';
  if (row.travelPayMode !== 'MONTHLY_AMOUNT') return 'notPaid';
  return row.history.length > 0 ? 'entered' : 'notEntered';
}

/** A placement's days in the month, for partDates: the whole month is one part. */
function rowDays(row: TravelAmountRow, month: YearMonth) {
  const { first, last } = monthDays(month);
  return {
    part: { from: first, until: last },
    days: { from: row.from > first ? row.from : first, until: row.until && row.until < last ? row.until : last },
  };
}

/** Monthly travel amounts per placement (AGENTS.md: Travel pay). */
export function TravelAmountsPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('travelAmounts.title')} description={t('travelAmounts.description')} />
      <RequireAccess allowed={canEnterMonthlyHours}>{(me) => <TravelAmountsView me={me} />}</RequireAccess>
    </>
  );
}

function TravelAmountsView({ me }: { me: Me }) {
  const { t } = useTranslation();
  const format = useFormat();
  const queryClient = useQueryClient();
  const currency = me.activeCompany!.currency;
  const [month, setMonth] = useState<YearMonth>(currentMonth);
  const [editing, setEditing] = useState<TravelAmountRow | null>(null);
  const data = useTravelAmounts(month);
  const locked = data.data?.locked ?? false;
  const showDepartments = usesDepartments(me);
  const departments = useDepartments({ enabled: showDepartments });
  const [chosenSite, setSiteFilter] = useState(ALL_SITES);
  const [departmentFilter, setDepartmentFilter] = useState<DepartmentFilterValue>('all');
  const sites = useMemo(() => siteChoices(data.data?.rows.map((r) => r.siteName) ?? []), [data.data]);
  // A site without rows in the month on screen falls back to all of them.
  const siteFilter = sites.some((s) => s.value === chosenSite) ? chosenSite : ALL_SITES;
  const rows = useMemo(
    () =>
      data.data?.rows.filter(
        (r) =>
          (siteFilter === ALL_SITES || r.siteName === siteFilter) &&
          (!showDepartments || inDepartmentFilter(departmentFilter, r.departmentId, departments.data ?? [])),
      ),
    [data.data, siteFilter, showDepartments, departmentFilter, departments.data],
  );

  const columns = useMemo<ColumnDef<TravelAmountRow, unknown>[]>(
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
        id: 'placement',
        accessorFn: (r) => r.siteName,
        header: t('workers.site'),
        cell: ({ row }) => (
          <div className="min-w-36">
            <div>{[row.original.siteName, row.original.teamName].filter(Boolean).join(' · ')}</div>
            <div className="text-sm text-muted-foreground">{partDates(rowDays(row.original, month), month, format.date, t)}</div>
          </div>
        ),
      },
      {
        id: 'amount',
        accessorFn: (r) => (r.history[0] ? Number(r.history[0].amount) : -1),
        header: t('travelAmounts.amount'),
        cell: ({ row }) => {
          const current = row.original.history[0];
          return <span className="tabular-nums">{current ? format.money(current.amount, currency) : '—'}</span>;
        },
      },
      {
        id: 'status',
        header: t('workers.status'),
        enableSorting: false,
        cell: ({ row }) => {
          const status = amountStatus(row.original);
          return <StatusBadge tone={STATUS_TONES[status]}>{t(`travelAmounts.${status}`)}</StatusBadge>;
        },
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{t('common.actions')}</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setEditing(row.original)}
            aria-label={t('travelAmounts.enterFor', { name: workerName(row.original.worker) })}
          >
            <Pencil aria-hidden />
          </Button>
        ),
      },
    ],
    [t, format, month, currency],
  );

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
        searchText={(r) => [workerSearchText(r.worker), r.siteName, r.teamName].filter(Boolean).join(' ')}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <MonthSwitcher value={month} onChange={setMonth} />
            <SiteFilter sites={sites} value={siteFilter} onChange={setSiteFilter} />
            {showDepartments && (
              <DepartmentFilter departments={departments.data ?? []} value={departmentFilter} onChange={setDepartmentFilter} />
            )}
            {locked && <StatusBadge tone="neutral">{t('monthlyHours.locked')}</StatusBadge>}
          </div>
        }
        emptyTitle={t('travelAmounts.emptyTitle')}
        emptyDescription={t('travelAmounts.emptyDescription')}
      />
      {editing && (
        <AmountDialog
          // A fresh form for each placement opened
          key={editing.assignmentId}
          month={month}
          row={editing}
          currency={currency}
          locked={locked}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            toast.success(t('common.saved'));
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: TRAVEL_AMOUNTS_KEY }),
              queryClient.invalidateQueries({ queryKey: PAYROLL_KEY }),
            ]);
          }}
        />
      )}
    </>
  );
}

/** Enter (or correct) a placement's travel amount for the month, and see what was entered before. */
function AmountDialog({
  month,
  row,
  currency,
  locked,
  onClose,
  onSaved,
}: {
  month: YearMonth;
  row: TravelAmountRow;
  currency: string;
  locked: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const [formError, setFormError] = useState<string>();
  const form = useForm<TravelAmountInput, unknown, TravelAmount>({
    resolver: zodResolver(travelAmountSchema),
    defaultValues: { amount: row.history[0]?.amount ?? '', note: '' },
  });
  const { errors } = form.formState;
  const status = amountStatus(row);

  const save = useMutation({
    mutationFn: (values: TravelAmount) => api.post(`/travel-amounts/${month.year}/${month.month}/${row.assignmentId}`, values),
    onSuccess: onSaved,
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('travelAmounts.dialogTitle', { month: format.month(month.year, month.month) })}</DialogTitle>
          <DialogDescription>
            {[workerName(row.worker), row.siteName, partDates(rowDays(row, month), month, format.date, t)].filter(Boolean).join(' · ')} ·{' '}
            {t('travelAmounts.dialogHint')}
          </DialogDescription>
        </DialogHeader>
        {(status === 'notPaid' || status === 'noRules') && (
          <p className="text-sm text-muted-foreground">{t(`travelAmounts.${status}Hint`)}</p>
        )}
        {locked ? (
          <p className="text-sm text-muted-foreground">{t('travelAmounts.lockedHint')}</p>
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
            <Field id="ta-amount" label={t('travelAmounts.amountIn', { currency })} error={errors.amount} hint={t('travelAmounts.amountHint')}>
              <Input {...fieldControlProps('ta-amount', errors.amount)} {...form.register('amount')} inputMode="decimal" autoComplete="off" />
            </Field>
            <Field id="ta-note" label={t('monthlyHours.note')} error={errors.note} hint={t('monthlyHours.noteHint')}>
              <Input {...fieldControlProps('ta-note', errors.note)} {...form.register('note')} autoComplete="off" />
            </Field>
            <FormActions submitLabel={t('common.save')} pending={save.isPending} onCancel={onClose} />
          </form>
        )}
        {row.history.length > 0 && (
          <section className="space-y-2 border-t pt-4">
            <h3 className="text-sm font-medium">{t('monthlyHours.history')}</h3>
            <ul className="space-y-2 text-sm">
              {row.history.map((h) => (
                <li key={h.id} className="flex flex-col gap-0.5">
                  <span className={h.corrected ? 'text-muted-foreground line-through tabular-nums' : 'tabular-nums'}>
                    {format.money(h.amount, currency)}
                  </span>
                  {h.corrected && (
                    <span>
                      <StatusBadge tone="neutral">{t('common.corrected')}</StatusBadge>
                    </span>
                  )}
                  {h.note && <span className="text-muted-foreground">{h.note}</span>}
                  <span className="text-muted-foreground">
                    {h.setBy.fullName} · {format.date(h.setAt)}
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
