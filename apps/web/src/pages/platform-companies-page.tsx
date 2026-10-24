import { zodResolver } from '@hookform/resolvers/zod';
import {
  createCompanySchema,
  subscriptionPaymentSchema,
  updatePlatformCompanySchema,
  type CreateCompanyInput,
  type SubscriptionPaymentInput,
  type UpdatePlatformCompanyInput,
} from '@puantaj/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Building2, MoreHorizontal, Pencil, Power, Wallet } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable } from '@/components/data-table';
import { DatePicker } from '@/components/date-picker';
import { Field, fieldControlProps, FormActions, FormError } from '@/components/form';
import { PageHeader } from '@/components/page-header';
import { RequireAccess } from '@/components/require-access';
import { StatusBadge } from '@/components/status-badge';
import { TemporaryPasswordDialog } from '@/components/temporary-password-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { useFormat } from '@/hooks/use-format';
import { api } from '@/lib/api';
import { isPlatformAdmin, ME_KEY, useMe, type Subscription } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { today } from '@/lib/format';
import {
  PLATFORM_CURRENCY,
  PLATFORM_KEY,
  useCompanies,
  usePlans,
  type CompanyRow,
  type PaymentRow,
} from '@/lib/platform';

type CompanyAction = 'activate' | 'deactivate';

export function PlatformCompaniesPage() {
  const { t } = useTranslation();
  const me = useMe().data;
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title={t('platform.title')}
        description={t('platform.description')}
        actions={
          isPlatformAdmin(me) && (
            <Button onClick={() => setCreating(true)}>
              <Building2 aria-hidden />
              {t('platform.create')}
            </Button>
          )
        }
      />
      <RequireAccess allowed={isPlatformAdmin}>
        {() => <CompaniesView creating={creating} onCreatingChange={setCreating} />}
      </RequireAccess>
    </>
  );
}

function CompaniesView({ creating, onCreatingChange }: { creating: boolean; onCreatingChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const format = useFormat();
  const queryClient = useQueryClient();
  const companies = useCompanies();
  const [editing, setEditing] = useState<CompanyRow | null>(null);
  const [paying, setPaying] = useState<CompanyRow | null>(null);
  const [confirm, setConfirm] = useState<{ company: CompanyRow; action: CompanyAction } | null>(null);
  const [tempPassword, setTempPassword] = useState<{ password: string; forWhom: string } | null>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: PLATFORM_KEY }),
      // The admin may own or join companies, which changes their company list.
      queryClient.invalidateQueries({ queryKey: ME_KEY }),
    ]);

  const columns = useMemo<ColumnDef<CompanyRow, unknown>[]>(
    () => [
      {
        accessorKey: 'name',
        header: t('platform.company'),
        cell: ({ row }) => (
          <div className="min-w-40">
            <div className="font-medium">{row.original.name}</div>
            {row.original.owners.map((o) => (
              <div key={o.fullName + (o.phone ?? o.email)} className="text-sm text-muted-foreground">
                {o.fullName} · {o.phone ?? o.email}
              </div>
            ))}
          </div>
        ),
      },
      {
        id: 'plan',
        header: t('platform.plan'),
        enableSorting: false,
        cell: ({ row }) => {
          const { plan, nextPlan, activeWorkers } = row.original;
          const next = nextPlan && (
            <div className="mt-1">
              <StatusBadge tone="warning">
                {t('platform.nextPlan', {
                  month: format.month(Number(nextPlan.fromMonth.slice(0, 4)), Number(nextPlan.fromMonth.slice(5, 7))),
                  name: nextPlan.name,
                })}
              </StatusBadge>
            </div>
          );
          if (!plan) {
            return (
              <div className="min-w-36">
                <StatusBadge tone="warning">{t('platform.noPlan')}</StatusBadge>
                {next}
              </div>
            );
          }
          return (
            <div className="min-w-36">
              <div>{plan.name}</div>
              <div className="text-sm text-muted-foreground">
                {t('platform.activeWorkers', {
                  active: format.number(activeWorkers),
                  limit: format.number(plan.maxActiveWorkers),
                })}
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                <StatusBadge tone="info">{t('modules.PAYROLL')}</StatusBadge>
                {plan.timesheetModule && <StatusBadge tone="info">{t('modules.TIMESHEET')}</StatusBadge>}
              </div>
              {next}
            </div>
          );
        },
      },
      {
        id: 'subscription',
        header: t('platform.subscription'),
        enableSorting: false,
        cell: ({ row }) => <SubscriptionStatus subscription={row.original.subscription} />,
      },
      { accessorKey: 'memberCount', header: t('platform.members') },
      {
        accessorKey: 'isActive',
        header: t('users.status'),
        cell: ({ row }) =>
          row.original.isActive ? (
            <StatusBadge tone="success">{t('users.active')}</StatusBadge>
          ) : (
            <StatusBadge tone="neutral">{t('users.inactive')}</StatusBadge>
          ),
      },
      {
        accessorKey: 'createdAt',
        header: t('platform.created'),
        cell: ({ row }) => format.date(row.original.createdAt),
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
                {t('platform.edit')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setPaying(row.original)}>
                <Wallet aria-hidden />
                {t('platform.payments')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setConfirm({ company: row.original, action: row.original.isActive ? 'deactivate' : 'activate' })}
              >
                <Power aria-hidden />
                {row.original.isActive ? t('platform.deactivate') : t('platform.activate')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [t, format],
  );

  return (
    <>
      <DataTable
        columns={columns}
        data={companies.data}
        isLoading={companies.isPending}
        isError={companies.isError}
        onRetry={() => companies.refetch()}
        searchable
        searchText={(c) =>
          [c.name, c.plan?.name, c.nextPlan?.name, ...c.owners.flatMap((o) => [o.fullName, o.phone, o.email])].filter(Boolean).join(' ')
        }
        emptyTitle={t('platform.empty')}
      />

      <CreateCompanyDialog
        open={creating}
        onClose={() => onCreatingChange(false)}
        onCreated={async (result, values) => {
          onCreatingChange(false);
          await refresh();
          if (result.temporaryPassword) {
            const contact = values.owner.phone || values.owner.email;
            setTempPassword({ password: result.temporaryPassword, forWhom: `${values.owner.fullName} (${contact})` });
          } else {
            toast.success(t('platform.createdExistingOwner'));
          }
        }}
      />
      <EditCompanyDialog
        company={editing}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          toast.success(t('common.saved'));
          await refresh();
        }}
      />
      <PaymentsDialog company={paying} onClose={() => setPaying(null)} onRecorded={refresh} />
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm ? t(`platform.confirm.${confirm.action}.title`) : ''}
        description={confirm ? t(`platform.confirm.${confirm.action}.description`, { name: confirm.company.name }) : ''}
        confirmLabel={confirm ? t(`platform.confirm.${confirm.action}.button`) : ''}
        destructive={confirm?.action === 'deactivate'}
        onConfirm={async () => {
          if (!confirm) return;
          await api.patch(`/platform/companies/${confirm.company.id}`, { isActive: confirm.action === 'activate' });
          toast.success(t('common.saved'));
          await refresh();
        }}
      />
      <TemporaryPasswordDialog
        password={tempPassword?.password ?? null}
        forWhom={tempPassword?.forWhom ?? ''}
        onClose={() => setTempPassword(null)}
      />
    </>
  );
}

/** Paid, in its grace period, read-only, or without an end date; with the date that matters. */
function SubscriptionStatus({ subscription }: { subscription: Subscription }) {
  const { t } = useTranslation();
  const format = useFormat();
  const { status, paidUntil, graceEndsOn } = subscription;
  switch (status) {
    case 'ACTIVE':
      return <StatusBadge tone="success">{t('platform.paidUntil', { date: format.date(paidUntil!) })}</StatusBadge>;
    case 'GRACE':
      return <StatusBadge tone="warning">{t('platform.graceUntil', { date: format.date(graceEndsOn!) })}</StatusBadge>;
    case 'READ_ONLY':
      return <StatusBadge tone="danger">{t('platform.readOnlySince', { date: format.date(graceEndsOn!) })}</StatusBadge>;
    case 'NONE':
      return <StatusBadge tone="neutral">{t('platform.noPaidUntil')}</StatusBadge>;
  }
}

/**
 * The plans a company can be put on: the offered ones, plus its own plans (this month's
 * and a pending one) if they were archived since (it may keep them).
 */
function PlanSelect({
  id,
  value,
  onChange,
  invalid,
  ownPlanIds = [],
}: {
  id: string;
  value: string | undefined;
  onChange: (planId: string) => void;
  invalid?: boolean;
  ownPlanIds?: string[];
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const plans = usePlans();
  const choices = plans.data?.filter((p) => p.isActive || ownPlanIds.includes(p.id)) ?? [];
  return (
    <Select value={value ?? ''} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full" aria-invalid={invalid ? true : undefined}>
        <SelectValue placeholder={t('platform.choosePlan')} />
      </SelectTrigger>
      <SelectContent>
        {choices.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {t('platform.planOption', {
              name: p.name,
              price: format.money(p.monthlyPrice, PLATFORM_CURRENCY),
              limit: format.number(p.maxActiveWorkers),
            })}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CreateCompanyDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (result: { temporaryPassword: string | null }, values: CreateCompanyInput) => void;
}) {
  const { t } = useTranslation();
  const [formError, setFormError] = useState<string>();
  const form = useForm<CreateCompanyInput>({
    resolver: zodResolver(createCompanySchema),
    defaultValues: {
      name: '',
      currency: 'UZS',
      timezone: 'Asia/Tashkent',
      owner: { fullName: '', phone: '', email: '' },
      planId: '',
      paidUntil: '',
    },
  });
  const { errors } = form.formState;

  const close = () => {
    form.reset();
    setFormError(undefined);
    onClose();
  };

  const create = useMutation({
    mutationFn: (values: CreateCompanyInput) =>
      api.post<{ temporaryPassword: string | null }>('/platform/companies', values),
    onSuccess: (result, values) => {
      form.reset();
      onCreated(result, values);
    },
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !create.isPending && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('platform.create')}</DialogTitle>
          <DialogDescription>{t('platform.createDescription')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={form.handleSubmit((values) => {
            setFormError(undefined);
            create.mutate(values);
          })}
        >
          <FormError message={formError} />
          <Field id="c-name" label={t('company.name')} error={errors.name} hint={t('platform.currencyLater')}>
            <Input {...fieldControlProps('c-name', errors.name)} {...form.register('name')} autoComplete="off" />
          </Field>
          <Controller
            control={form.control}
            name="planId"
            render={({ field }) => (
              <Field id="c-plan" label={t('platform.plan')} error={errors.planId}>
                <PlanSelect id="c-plan" value={field.value} onChange={field.onChange} invalid={!!errors.planId} />
              </Field>
            )}
          />
          <Controller
            control={form.control}
            name="paidUntil"
            render={({ field }) => (
              <Field id="c-paid-until" label={t('platform.firstPaidUntil')} error={errors.paidUntil} hint={t('platform.firstPaidUntilHint')}>
                <DatePicker id="c-paid-until" value={field.value} onChange={field.onChange} invalid={!!errors.paidUntil} />
              </Field>
            )}
          />
          <Separator />
          <p className="text-sm font-medium">{t('platform.ownerSection')}</p>
          <Field id="c-owner-name" label={t('users.name')} error={errors.owner?.fullName}>
            <Input
              {...fieldControlProps('c-owner-name', errors.owner?.fullName)}
              {...form.register('owner.fullName')}
              autoComplete="off"
            />
          </Field>
          <Field id="c-owner-phone" label={t('users.phone')} error={errors.owner?.phone} hint={t('users.phoneHint')}>
            <Input
              {...fieldControlProps('c-owner-phone', errors.owner?.phone)}
              {...form.register('owner.phone')}
              type="tel"
              inputMode="tel"
              placeholder="+998 90 123 45 67"
              autoComplete="off"
            />
          </Field>
          <Field id="c-owner-email" label={t('users.email')} error={errors.owner?.email}>
            <Input
              {...fieldControlProps('c-owner-email', errors.owner?.email)}
              {...form.register('owner.email')}
              type="email"
              inputMode="email"
              autoComplete="off"
            />
          </Field>
          <FormActions submitLabel={t('platform.create')} pending={create.isPending} onCancel={close} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Name, currency, time zone and plan. */
function EditCompanyDialog({
  company,
  onClose,
  onSaved,
}: {
  company: CompanyRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [formError, setFormError] = useState<string>();
  const form = useForm<UpdatePlatformCompanyInput>({
    resolver: zodResolver(updatePlatformCompanySchema),
    values: {
      name: company?.name ?? '',
      currency: company?.currency ?? '',
      timezone: company?.timezone ?? '',
      // What next month will have: the pending change, or this month's plan.
      planId: company?.nextPlan?.id ?? company?.plan?.id,
    },
  });
  const { errors } = form.formState;

  const close = () => {
    setFormError(undefined);
    onClose();
  };

  const save = useMutation({
    mutationFn: (values: UpdatePlatformCompanyInput) => api.patch(`/platform/companies/${company!.id}`, values),
    onSuccess: onSaved,
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open={company !== null} onOpenChange={(open) => !open && !save.isPending && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('platform.edit')}</DialogTitle>
          <DialogDescription>{t('platform.editDescription')}</DialogDescription>
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
          <Field id="e-name" label={t('company.name')} error={errors.name}>
            <Input {...fieldControlProps('e-name', errors.name)} {...form.register('name')} autoComplete="off" />
          </Field>
          <Field id="e-currency" label={t('company.currency')} error={errors.currency}>
            <Input {...fieldControlProps('e-currency', errors.currency)} {...form.register('currency')} autoComplete="off" />
          </Field>
          <Field id="e-timezone" label={t('company.timezone')} error={errors.timezone}>
            <Input {...fieldControlProps('e-timezone', errors.timezone)} {...form.register('timezone')} autoComplete="off" />
          </Field>
          <Controller
            control={form.control}
            name="planId"
            render={({ field }) => (
              <Field id="e-plan" label={t('platform.plan')} error={errors.planId} hint={t('platform.planChangeHint')}>
                <PlanSelect
                  id="e-plan"
                  value={field.value}
                  onChange={field.onChange}
                  invalid={!!errors.planId}
                  ownPlanIds={[company?.plan?.id, company?.nextPlan?.id].filter((p) => p !== undefined)}
                />
              </Field>
            )}
          />
          <FormActions submitLabel={t('common.save')} pending={save.isPending} onCancel={close} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

const NEW_PAYMENT = (): SubscriptionPaymentInput => ({ amount: '', paidOn: today(), paidUntil: '', note: '' });

/** Records a payment made outside the app (it sets the paid-until date) and lists earlier ones. */
function PaymentsDialog({
  company,
  onClose,
  onRecorded,
}: {
  company: CompanyRow | null;
  onClose: () => void;
  onRecorded: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const queryClient = useQueryClient();
  const paymentsKey = [...PLATFORM_KEY, 'payments', company?.id] as const;
  const payments = useQuery({
    queryKey: paymentsKey,
    queryFn: () => api.get<PaymentRow[]>(`/platform/companies/${company!.id}/payments`),
    enabled: company !== null,
  });
  const [formError, setFormError] = useState<string>();
  const form = useForm<SubscriptionPaymentInput>({
    resolver: zodResolver(subscriptionPaymentSchema),
    defaultValues: NEW_PAYMENT(),
  });
  const { errors } = form.formState;

  const close = () => {
    form.reset(NEW_PAYMENT());
    setFormError(undefined);
    onClose();
  };

  const record = useMutation({
    mutationFn: (values: SubscriptionPaymentInput) => api.post(`/platform/companies/${company!.id}/payments`, values),
    onSuccess: async () => {
      form.reset(NEW_PAYMENT());
      toast.success(t('platform.paymentRecorded'));
      await Promise.all([queryClient.invalidateQueries({ queryKey: paymentsKey }), onRecorded()]);
    },
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  const columns = useMemo<ColumnDef<PaymentRow, unknown>[]>(
    () => [
      { accessorKey: 'paidOn', header: t('platform.paidOn'), cell: ({ row }) => format.date(row.original.paidOn) },
      {
        accessorKey: 'amount',
        header: t('platform.amount'),
        cell: ({ row }) => format.money(row.original.amount, PLATFORM_CURRENCY),
      },
      {
        accessorKey: 'paidUntil',
        header: t('platform.newPaidUntil'),
        cell: ({ row }) => format.date(row.original.paidUntil),
      },
      {
        id: 'note',
        header: t('platform.note'),
        enableSorting: false,
        cell: ({ row }) => (
          <div className="min-w-32">
            {row.original.note && <div>{row.original.note}</div>}
            <div className="text-sm text-muted-foreground">{row.original.recordedBy}</div>
          </div>
        ),
      },
    ],
    [t, format],
  );

  return (
    <Dialog open={company !== null} onOpenChange={(open) => !open && !record.isPending && close()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('platform.payments')}</DialogTitle>
          <DialogDescription>
            {company && (
              <>
                {company.name} · <SubscriptionStatus subscription={company.subscription} />
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={form.handleSubmit((values) => {
            setFormError(undefined);
            record.mutate(values);
          })}
        >
          <FormError message={formError} />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id="pay-amount" label={t('platform.amountSom')} error={errors.amount} hint={t('platform.amountHint')}>
              <Input {...fieldControlProps('pay-amount', errors.amount)} {...form.register('amount')} inputMode="decimal" autoComplete="off" />
            </Field>
            <Controller
              control={form.control}
              name="paidOn"
              render={({ field }) => (
                <Field id="pay-on" label={t('platform.paidOn')} error={errors.paidOn}>
                  <DatePicker id="pay-on" value={field.value} onChange={field.onChange} invalid={!!errors.paidOn} />
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="paidUntil"
              render={({ field }) => (
                <Field id="pay-until" label={t('platform.newPaidUntil')} error={errors.paidUntil}>
                  <DatePicker
                    id="pay-until"
                    value={field.value}
                    onChange={field.onChange}
                    invalid={!!errors.paidUntil}
                    defaultMonth={company?.subscription.paidUntil ?? undefined}
                  />
                </Field>
              )}
            />
          </div>
          <Field id="pay-note" label={t('platform.note')} error={errors.note}>
            <Input {...fieldControlProps('pay-note', errors.note)} {...form.register('note')} autoComplete="off" />
          </Field>
          <FormActions submitLabel={t('platform.recordPayment')} pending={record.isPending} onCancel={close} />
        </form>
        <Separator />
        <DataTable
          columns={columns}
          data={payments.data}
          isLoading={payments.isPending}
          isError={payments.isError}
          onRetry={() => payments.refetch()}
          emptyTitle={t('platform.noPayments')}
          pageSize={5}
        />
      </DialogContent>
    </Dialog>
  );
}
