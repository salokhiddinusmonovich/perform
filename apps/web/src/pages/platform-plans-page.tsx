import { zodResolver } from '@hookform/resolvers/zod';
import { planSchema, type PlanInput } from '@puantaj/schemas';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable } from '@/components/data-table';
import { Field, fieldControlProps, FormActions, FormError } from '@/components/form';
import { PageHeader } from '@/components/page-header';
import { RequireAccess } from '@/components/require-access';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useFormat } from '@/hooks/use-format';
import { api } from '@/lib/api';
import { isPlatformAdmin, useMe } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { PLATFORM_CURRENCY, PLATFORM_KEY, usePlans, type PlanRow } from '@/lib/platform';

export function PlatformPlansPage() {
  const { t } = useTranslation();
  const me = useMe().data;
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title={t('plans.title')}
        description={t('plans.description')}
        actions={
          isPlatformAdmin(me) && (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              {t('plans.create')}
            </Button>
          )
        }
      />
      <RequireAccess allowed={isPlatformAdmin}>
        {() => <PlansView creating={creating} onCreatingChange={setCreating} />}
      </RequireAccess>
    </>
  );
}

function PlansView({ creating, onCreatingChange }: { creating: boolean; onCreatingChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const format = useFormat();
  const queryClient = useQueryClient();
  const plans = usePlans();
  const [editing, setEditing] = useState<PlanRow | null>(null);
  const [archiving, setArchiving] = useState<PlanRow | null>(null);

  // Plans show on the companies page too.
  const refresh = () => queryClient.invalidateQueries({ queryKey: PLATFORM_KEY });

  const columns = useMemo<ColumnDef<PlanRow, unknown>[]>(
    () => [
      {
        accessorKey: 'name',
        header: t('plans.name'),
        cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      },
      {
        accessorKey: 'monthlyPrice',
        header: t('plans.monthlyPrice'),
        sortingFn: (a, b) => Number(a.original.monthlyPrice) - Number(b.original.monthlyPrice),
        cell: ({ row }) => format.money(row.original.monthlyPrice, PLATFORM_CURRENCY),
      },
      {
        accessorKey: 'maxActiveWorkers',
        header: t('plans.maxActiveWorkers'),
        cell: ({ row }) => format.number(row.original.maxActiveWorkers),
      },
      {
        id: 'modules',
        header: t('platform.modules'),
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            <StatusBadge tone="info">{t('modules.PAYROLL')}</StatusBadge>
            {row.original.timesheetModule && <StatusBadge tone="info">{t('modules.TIMESHEET')}</StatusBadge>}
          </div>
        ),
      },
      { accessorKey: 'companyCount', header: t('plans.companies') },
      {
        accessorKey: 'isActive',
        header: t('users.status'),
        cell: ({ row }) =>
          row.original.isActive ? (
            <StatusBadge tone="success">{t('plans.offered')}</StatusBadge>
          ) : (
            <StatusBadge tone="neutral">{t('plans.archived')}</StatusBadge>
          ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{t('common.actions')}</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={t('common.actionsFor', { name: row.original.name })}>
                <MoreHorizontal aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setEditing(row.original)}>
                <Pencil aria-hidden />
                {t('plans.edit')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setArchiving(row.original)}>
                {row.original.isActive ? <Archive aria-hidden /> : <ArchiveRestore aria-hidden />}
                {row.original.isActive ? t('plans.archive') : t('plans.restore')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [t, format],
  );

  const archive = archiving?.isActive ? 'archive' : 'restore';
  return (
    <>
      <DataTable
        columns={columns}
        data={plans.data}
        isLoading={plans.isPending}
        isError={plans.isError}
        onRetry={() => plans.refetch()}
        emptyTitle={t('plans.empty')}
      />
      <PlanDialog
        open={creating || editing !== null}
        plan={editing}
        onClose={() => {
          onCreatingChange(false);
          setEditing(null);
        }}
        onSaved={async () => {
          onCreatingChange(false);
          setEditing(null);
          toast.success(t('common.saved'));
          await refresh();
        }}
      />
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => !open && setArchiving(null)}
        title={t(`plans.confirm.${archive}.title`)}
        description={archiving ? t(`plans.confirm.${archive}.description`, { name: archiving.name }) : ''}
        confirmLabel={t(`plans.confirm.${archive}.button`)}
        destructive={archive === 'archive'}
        onConfirm={async () => {
          if (!archiving) return;
          await api.patch(`/platform/plans/${archiving.id}`, { isActive: !archiving.isActive });
          toast.success(t('common.saved'));
          await refresh();
        }}
      />
    </>
  );
}

const EMPTY_PLAN: PlanInput = { name: '', monthlyPrice: '', maxActiveWorkers: Number.NaN, timesheetModule: false };

/** Creates a plan, or edits one (only its name once a company has had it). */
function PlanDialog({
  open,
  plan,
  onClose,
  onSaved,
}: {
  open: boolean;
  plan: PlanRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const [formError, setFormError] = useState<string>();
  const form = useForm<PlanInput>({
    resolver: zodResolver(planSchema),
    values: plan
      ? {
          name: plan.name,
          monthlyPrice: plan.monthlyPrice,
          maxActiveWorkers: plan.maxActiveWorkers,
          timesheetModule: plan.timesheetModule,
        }
      : EMPTY_PLAN,
  });
  const { errors } = form.formState;

  const close = () => {
    form.reset(EMPTY_PLAN);
    setFormError(undefined);
    onClose();
  };

  const save = useMutation({
    mutationFn: (values: PlanInput) =>
      plan ? api.patch(`/platform/plans/${plan.id}`, values) : api.post('/platform/plans', values),
    onSuccess: () => {
      form.reset(EMPTY_PLAN);
      onSaved();
    },
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !save.isPending && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{plan ? t('plans.edit') : t('plans.create')}</DialogTitle>
          <DialogDescription>{plan ? t('plans.editDescription', { companies: plan.companyCount }) : t('plans.createDescription')}</DialogDescription>
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
          <Field id="p-name" label={t('plans.name')} error={errors.name}>
            <Input {...fieldControlProps('p-name', errors.name)} {...form.register('name')} autoComplete="off" />
          </Field>
          {plan?.inUse ? (
            // Fixed once a company has had the plan; the form sends them back unchanged.
            <div className="space-y-2">
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                {[
                  [t('plans.monthlyPriceSom'), format.money(plan.monthlyPrice, PLATFORM_CURRENCY)],
                  [t('plans.maxActiveWorkers'), format.number(plan.maxActiveWorkers)],
                  [
                    t('platform.modules'),
                    plan.timesheetModule ? `${t('modules.PAYROLL')}, ${t('modules.TIMESHEET')}` : t('modules.PAYROLL'),
                  ],
                ].map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <dt className="text-sm text-muted-foreground">{label}</dt>
                    <dd className="font-medium">{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-sm text-muted-foreground">{t('plans.termsFixed')}</p>
            </div>
          ) : (
            <>
              <Field id="p-price" label={t('plans.monthlyPriceSom')} error={errors.monthlyPrice}>
                <Input
                  {...fieldControlProps('p-price', errors.monthlyPrice)}
                  {...form.register('monthlyPrice')}
                  inputMode="decimal"
                  autoComplete="off"
                />
              </Field>
              <Field id="p-workers" label={t('plans.maxActiveWorkers')} error={errors.maxActiveWorkers} hint={t('plans.maxActiveWorkersHint')}>
                <Input
                  {...fieldControlProps('p-workers', errors.maxActiveWorkers)}
                  {...form.register('maxActiveWorkers', { valueAsNumber: true })}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  autoComplete="off"
                />
              </Field>
              <Controller
                control={form.control}
                name="timesheetModule"
                render={({ field }) => (
                  <div className="flex min-h-10 items-center gap-3">
                    <Checkbox id="p-timesheet" checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} />
                    <Label htmlFor="p-timesheet">{t('plans.includesTimesheet')}</Label>
                  </div>
                )}
              />
            </>
          )}
          <FormActions submitLabel={plan ? t('common.save') : t('plans.create')} pending={save.isPending} onCancel={close} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
