import { zodResolver } from '@hookform/resolvers/zod';
import {
  ABSENCE_RULE_TYPES,
  NEW_PAY_RULES,
  payRulesSchema,
  TRAVEL_PAY_MODES,
  WEEKDAYS,
  type PayRules,
  type PayRulesInput,
} from '@puantaj/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Pencil, Scale, Trash2 } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Controller, useForm, type FieldError } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { Field, fieldControlProps, FormActions, FormError } from '@/components/form';
import { LoadingState } from '@/components/loading-state';
import { PageHeader } from '@/components/page-header';
import { RequireAccess } from '@/components/require-access';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useFormat } from '@/hooks/use-format';
import { api } from '@/lib/api';
import { canManageCompany, canViewPayRules, type Me } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';

interface Version {
  fromYear: number;
  fromMonth: number;
  rules: PayRules;
  setBy: { fullName: string };
  setAt: string;
}

interface YearMonth {
  year: number;
  month: number;
}

const PAY_RULES_KEY = ['pay-rules'] as const;
const WORKING_DAYS_KEY = ['working-days'] as const;

const monthIndex = (year: number, month: number) => year * 12 + month - 1;

function thisMonth(): YearMonth {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

/** The version that applies to a month: the latest one starting at or before it. Versions are newest first. */
function versionFor(versions: Version[], { year, month }: YearMonth): Version | undefined {
  return versions.find((v) => monthIndex(v.fromYear, v.fromMonth) <= monthIndex(year, month));
}

export function PayRulesPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('payRules.title')} description={t('payRules.description')} />
      <RequireAccess allowed={canViewPayRules}>{(me) => <PayRulesView me={me} />}</RequireAccess>
    </>
  );
}

/** What the form edits: a new version from a month the admin picks, or an existing version. */
type Editing = { from: YearMonth; fixedFrom: boolean; initial: PayRulesInput | typeof NEW_PAY_RULES };

function PayRulesView({ me }: { me: Me }) {
  const { t } = useTranslation();
  const format = useFormat();
  const queryClient = useQueryClient();
  const canChange = canManageCompany(me);
  const currency = me.activeCompany!.currency; // guaranteed by canViewPayRules
  const versions = useQuery({ queryKey: PAY_RULES_KEY, queryFn: () => api.get<Version[]>('/pay-rules') });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<Version | null>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: PAY_RULES_KEY }),
      queryClient.invalidateQueries({ queryKey: WORKING_DAYS_KEY }),
    ]);

  const columns = useMemo<ColumnDef<Version, unknown>[]>(
    () => [
      {
        id: 'from',
        accessorFn: (v) => monthIndex(v.fromYear, v.fromMonth),
        header: t('payRules.from'),
        cell: ({ row }) => <span className="font-medium">{format.month(row.original.fromYear, row.original.fromMonth)}</span>,
      },
      {
        id: 'multipliers',
        header: t('payRules.multipliersShort'),
        enableSorting: false,
        cell: ({ row }) => {
          const r = row.original.rules;
          return (
            <span className="whitespace-nowrap">
              {[r.overtimeMultiplier, r.restDayMultiplier, r.holidayMultiplier]
                .map((m) => t('payRules.times', { value: format.number(m) }))
                .join(' · ')}
            </span>
          );
        },
      },
      {
        id: 'normalHours',
        header: t('payRules.normalHoursPerDay'),
        enableSorting: false,
        cell: ({ row }) => t('payRules.hours', { value: format.number(row.original.rules.normalHoursPerDay) }),
      },
      {
        id: 'setBy',
        header: t('payRules.setBy'),
        enableSorting: false,
        cell: ({ row }) => (
          <div className="min-w-32">
            <div>{row.original.setBy.fullName}</div>
            <div className="text-sm text-muted-foreground">{format.date(row.original.setAt)}</div>
          </div>
        ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{t('common.actions')}</span>,
        enableSorting: false,
        cell: ({ row }) => {
          const v = row.original;
          const label = format.month(v.fromYear, v.fromMonth);
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={t('common.actionsFor', { name: label })}>
                  <MoreHorizontal aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() =>
                    setEditing({ from: { year: v.fromYear, month: v.fromMonth }, fixedFrom: true, initial: v.rules })
                  }
                >
                  <Pencil aria-hidden />
                  {canChange ? t('payRules.edit') : t('payRules.view')}
                </DropdownMenuItem>
                {canChange && (
                  <DropdownMenuItem onSelect={() => setDeleting(v)}>
                    <Trash2 aria-hidden />
                    {t('payRules.delete')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [t, format, canChange],
  );

  if (versions.isPending) return <LoadingState />;
  if (versions.isError) return <ErrorState onRetry={() => versions.refetch()} />;
  const list = versions.data;

  if (editing) {
    return (
      <PayRulesForm
        editing={editing}
        versions={list}
        currency={currency}
        readOnly={!canChange}
        onDone={async (saved) => {
          setEditing(null);
          if (saved) {
            toast.success(t('common.saved'));
            await refresh();
          }
        }}
      />
    );
  }

  if (list.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Scale}
          title={t('payRules.emptyTitle')}
          description={canChange ? t('payRules.emptyDescription') : t('payRules.emptyDescriptionReadOnly')}
          action={
            canChange && (
              <Button onClick={() => setEditing({ from: thisMonth(), fixedFrom: false, initial: NEW_PAY_RULES })}>
                {t('payRules.setUp')}
              </Button>
            )
          }
        />
      </Card>
    );
  }

  const now = thisMonth();
  const current = versionFor(list, now);
  const previous = deleting && list.find((v) => monthIndex(v.fromYear, v.fromMonth) < monthIndex(deleting.fromYear, deleting.fromMonth));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle>{t('payRules.inForce', { month: format.month(now.year, now.month) })}</CardTitle>
            <CardDescription>
              {current
                ? t('payRules.inForceSince', { month: format.month(current.fromYear, current.fromMonth) })
                : t('payRules.noneInForce')}
            </CardDescription>
          </div>
          {canChange && (
            <Button
              onClick={() =>
                setEditing({ from: now, fixedFrom: false, initial: (current ?? list[0]).rules })
              }
            >
              <Pencil aria-hidden />
              {t('payRules.change')}
            </Button>
          )}
        </CardHeader>
        {current && (
          <CardContent>
            <RulesSummary rules={current.rules} currency={currency} />
          </CardContent>
        )}
      </Card>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">{t('payRules.history')}</h2>
          <p className="text-sm text-muted-foreground">{t('payRules.historyHint')}</p>
        </div>
        <DataTable columns={columns} data={list} />
      </section>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('payRules.confirmDelete.title')}
        description={
          deleting
            ? previous
              ? t('payRules.confirmDelete.description', {
                  month: format.month(deleting.fromYear, deleting.fromMonth),
                  previous: format.month(previous.fromYear, previous.fromMonth),
                })
              : t('payRules.confirmDelete.descriptionNoPrevious', {
                  month: format.month(deleting.fromYear, deleting.fromMonth),
                })
            : ''
        }
        confirmLabel={t('payRules.delete')}
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          await api.delete(`/pay-rules/${deleting.fromYear}/${deleting.fromMonth}`);
          toast.success(t('common.saved'));
          await refresh();
        }}
      />
    </div>
  );
}

function RulesSummary({ rules, currency }: { rules: PayRules; currency: string }) {
  const { t } = useTranslation();
  const format = useFormat();
  const hours = (value: string) => t('payRules.hours', { value: format.number(value) });
  const times = (value: string) => t('payRules.times', { value: format.number(value) });

  const items: [string, string][] = [
    [
      t('payRules.restWeekdays'),
      rules.restWeekdays.length > 0 ? rules.restWeekdays.map((d) => format.weekday(d)).join(', ') : t('payRules.noRestDays'),
    ],
    [t('payRules.normalHoursPerDay'), hours(rules.normalHoursPerDay)],
    [t('payRules.multiplier.NORMAL'), times('1')],
    [t('payRules.multiplier.OVERTIME'), times(rules.overtimeMultiplier)],
    [t('payRules.multiplier.REST_DAY'), times(rules.restDayMultiplier)],
    [t('payRules.multiplier.HOLIDAY'), times(rules.holidayMultiplier)],
    ...ABSENCE_RULE_TYPES.map((type): [string, string] => {
      const rule = rules.absence[type];
      if (!rule.paid) return [t(`payRules.absence.${type}`), t('payRules.notPaid')];
      return [
        t(`payRules.absence.${type}`),
        rule.hoursPerDay === null
          ? t('payRules.paidNormalHours', { hours: hours(rules.normalHoursPerDay) })
          : t('payRules.paidHours', { hours: hours(rule.hoursPerDay) }),
      ];
    }),
    [t('payRules.travelPay'), t(`payRules.travelMode.${rules.travelPayMode}`)],
    [t('payRules.rounding'), format.money(rules.payRoundingStep, currency)],
  ];

  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-sm text-muted-foreground">{label}</dt>
          <dd className="font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PayRulesForm({
  editing,
  versions,
  currency,
  readOnly,
  onDone,
}: {
  editing: Editing;
  versions: Version[];
  currency: string;
  readOnly: boolean;
  onDone: (saved: boolean) => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const [from, setFrom] = useState<YearMonth>(editing.from);
  const [formError, setFormError] = useState<string>();
  const form = useForm<PayRulesInput, unknown, PayRules>({
    resolver: zodResolver(payRulesSchema),
    defaultValues: editing.initial,
    disabled: readOnly,
  });
  const { errors } = form.formState;
  const normalHours = form.watch('normalHoursPerDay');
  const replaces =
    !editing.fixedFrom && versions.some((v) => v.fromYear === from.year && v.fromMonth === from.month);

  const save = useMutation({
    mutationFn: (values: PayRules) => api.put(`/pay-rules/${from.year}/${from.month}`, values),
    onSuccess: () => onDone(true),
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  const years = useMemo(() => {
    const now = new Date().getFullYear();
    const list = Array.from({ length: 6 }, (_, i) => now - 3 + i);
    return list.includes(from.year) ? list : [from.year, ...list].sort();
  }, [from.year]);

  const decimal = (name: 'normalHoursPerDay' | 'overtimeMultiplier' | 'restDayMultiplier' | 'holidayMultiplier' | 'payRoundingStep', error?: FieldError) => (
    <Input {...fieldControlProps(name, error)} {...form.register(name)} inputMode="decimal" autoComplete="off" />
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {readOnly
            ? t('payRules.viewTitle', { month: format.month(from.year, from.month) })
            : editing.fixedFrom
              ? t('payRules.editTitle', { month: format.month(from.year, from.month) })
              : t('payRules.newTitle')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-8"
          noValidate
          onSubmit={form.handleSubmit((values) => {
            setFormError(undefined);
            save.mutate(values);
          })}
        >
          <FormError message={formError} />

          <fieldset className="space-y-1.5">
            <legend className="mb-1.5 text-sm font-medium">{t('payRules.appliesFrom')}</legend>
            <div className="grid max-w-md grid-cols-2 gap-2">
              <Select
                value={String(from.month)}
                onValueChange={(m) => setFrom({ ...from, month: Number(m) })}
                disabled={editing.fixedFrom || readOnly}
              >
                <SelectTrigger className="w-full" aria-label={t('common.month')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <SelectItem key={m} value={String(m)}>
                      {format.monthName(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={String(from.year)}
                onValueChange={(y) => setFrom({ ...from, year: Number(y) })}
                disabled={editing.fixedFrom || readOnly}
              >
                <SelectTrigger className="w-full" aria-label={t('common.year')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {years.map((y) => (
                    <SelectItem key={y} value={String(y)}>
                      {y}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-sm text-muted-foreground">{t('payRules.appliesFromHint')}</p>
            {replaces && (
              <StatusBadge tone="warning">
                {t('payRules.replacesVersion', { month: format.month(from.year, from.month) })}
              </StatusBadge>
            )}
          </fieldset>

          <Section title={t('payRules.workingTime')}>
            <Controller
              control={form.control}
              name="restWeekdays"
              render={({ field }) => (
                <fieldset className="space-y-1.5" aria-describedby={errors.restWeekdays ? 'restWeekdays-error' : undefined}>
                  <legend className="mb-1.5 text-sm font-medium">{t('payRules.restWeekdays')}</legend>
                  <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-4">
                    {WEEKDAYS.map((day) => (
                      <Label key={day} className="flex min-h-10 cursor-pointer items-center gap-2 font-normal">
                        <Checkbox
                          checked={field.value.includes(day)}
                          disabled={field.disabled}
                          onCheckedChange={(checked) =>
                            field.onChange(checked ? [...field.value, day] : field.value.filter((d) => d !== day))
                          }
                        />
                        {format.weekday(day)}
                      </Label>
                    ))}
                  </div>
                  {errors.restWeekdays?.message ? (
                    <p id="restWeekdays-error" role="alert" className="text-sm text-destructive">
                      {t(errors.restWeekdays.message)}
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t('payRules.restWeekdaysHint')}</p>
                  )}
                </fieldset>
              )}
            />
            <div className="max-w-xs">
              <Field
                id="normalHoursPerDay"
                label={t('payRules.normalHoursPerDay')}
                error={errors.normalHoursPerDay}
                hint={t('payRules.normalHoursHint')}
              >
                {decimal('normalHoursPerDay', errors.normalHoursPerDay)}
              </Field>
            </div>
          </Section>

          <Section title={t('payRules.multipliers')} description={t('payRules.multipliersHint')}>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field id="overtimeMultiplier" label={t('payRules.multiplier.OVERTIME')} error={errors.overtimeMultiplier} hint={t('payRules.overtimeHint')}>
                {decimal('overtimeMultiplier', errors.overtimeMultiplier)}
              </Field>
              <Field id="restDayMultiplier" label={t('payRules.multiplier.REST_DAY')} error={errors.restDayMultiplier} hint={t('payRules.restDayHint')}>
                {decimal('restDayMultiplier', errors.restDayMultiplier)}
              </Field>
              <Field id="holidayMultiplier" label={t('payRules.multiplier.HOLIDAY')} error={errors.holidayMultiplier} hint={t('payRules.holidayHint')}>
                {decimal('holidayMultiplier', errors.holidayMultiplier)}
              </Field>
            </div>
          </Section>

          <Section title={t('payRules.absences')} description={t('payRules.absencesHint')}>
            <div className="grid gap-4 sm:grid-cols-3">
              {ABSENCE_RULE_TYPES.map((type) => {
                const id = `absence-${type}`;
                const error = errors.absence?.[type]?.hoursPerDay;
                return (
                  <div key={type} className="space-y-2 rounded-lg border p-3">
                    <p className="font-medium">{t(`payRules.absence.${type}`)}</p>
                    <Controller
                      control={form.control}
                      name={`absence.${type}.paid`}
                      render={({ field }) => (
                        <Label className="flex min-h-10 cursor-pointer items-center gap-2 font-normal">
                          <Checkbox
                            checked={field.value}
                            disabled={field.disabled}
                            onCheckedChange={(checked) => field.onChange(checked === true)}
                          />
                          {t('payRules.paid')}
                        </Label>
                      )}
                    />
                    <Field id={id} label={t('payRules.hoursPerAbsenceDay')} error={error} hint={t('payRules.emptyIsNormalHours')}>
                      <Input
                        {...fieldControlProps(id, error)}
                        {...form.register(`absence.${type}.hoursPerDay`, { setValueAs: (v: string | null) => v ?? '' })}
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder={normalHours ? t('payRules.hours', { value: normalHours }) : undefined}
                      />
                    </Field>
                  </div>
                );
              })}
            </div>
          </Section>

          <Section title={t('payRules.travelPay')}>
            <Controller
              control={form.control}
              name="travelPayMode"
              render={({ field }) => (
                <div className="max-w-md">
                  <Field
                    id="travelPayMode"
                    label={t('payRules.travelPayMode')}
                    error={errors.travelPayMode}
                    hint={field.value ? t(`payRules.travelModeHint.${field.value}`) : undefined}
                  >
                    <Select value={field.value ?? ''} onValueChange={field.onChange} disabled={field.disabled}>
                      <SelectTrigger id="travelPayMode" className="w-full" aria-invalid={errors.travelPayMode ? true : undefined}>
                        <SelectValue placeholder={t('payRules.chooseTravelMode')} />
                      </SelectTrigger>
                      <SelectContent>
                        {TRAVEL_PAY_MODES.map((mode) => (
                          <SelectItem key={mode} value={mode}>
                            {t(`payRules.travelMode.${mode}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
              )}
            />
          </Section>

          <Section title={t('payRules.rounding')}>
            <div className="max-w-xs">
              <Field
                id="payRoundingStep"
                label={t('payRules.roundingStep', { currency })}
                error={errors.payRoundingStep}
                hint={t('payRules.roundingHint')}
              >
                {decimal('payRoundingStep', errors.payRoundingStep)}
              </Field>
            </div>
          </Section>

          {readOnly ? (
            <div className="flex justify-end">
              <Button type="button" variant="outline" onClick={() => onDone(false)}>
                {t('common.close')}
              </Button>
            </div>
          ) : (
            <FormActions submitLabel={t('common.save')} pending={save.isPending} onCancel={() => onDone(false)} />
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="space-y-4 border-t pt-6">
      <div>
        <h3 className="font-semibold">{title}</h3>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}
