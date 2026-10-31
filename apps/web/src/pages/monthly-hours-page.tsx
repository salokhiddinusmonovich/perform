import { zodResolver } from '@hookform/resolvers/zod';
import { monthlyHoursSchema, type MonthlyHours, type MonthlyHoursInput, type YearMonth } from '@puantaj/schemas';
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
import { ALL_SITES, ALL_TEAMS, SiteFilter, TeamFilter } from '@/components/list-filters';
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
import { canEnterMonthlyHours, usesDepartments, type Me } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { useDepartments, workerName, workerSearchText } from '@/lib/organisation';
import {
  currentMonth,
  HOURS_STATUSES,
  hoursStatus,
  MONTHLY_HOURS_KEY,
  PAYROLL_KEY,
  siteChoices,
  useMonthlyHours,
  type HoursStatus,
  type MonthlyHoursEntry,
  type MonthlyHoursRow,
} from '@/lib/payroll';
import { rowTeamKey, rowTeams } from '@/lib/timesheet';

const HOUR_FIELDS = ['normalHours', 'overtimeHours', 'restDayHours', 'holidayHours'] as const;
const DAY_FIELDS = ['workdaysWorked', 'leaveDays', 'sickDays', 'travelDays'] as const;
const STATUS_TONES = { notEntered: 'warning', shiftChanged: 'warning', entered: 'success', dailyEntries: 'info' } as const;

export function MonthlyHoursPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('monthlyHours.title')} description={t('monthlyHours.description')} />
      <RequireAccess allowed={canEnterMonthlyHours}>{(me) => <MonthlyHoursView me={me} />}</RequireAccess>
    </>
  );
}

function MonthlyHoursView({ me }: { me: Me }) {
  const { t } = useTranslation();
  const format = useFormat();
  const queryClient = useQueryClient();
  const [month, setMonth] = useState<YearMonth>(currentMonth);
  const [editing, setEditing] = useState<MonthlyHoursRow | null>(null);
  const data = useMonthlyHours(month);
  const locked = data.data?.locked ?? false;
  const showDepartments = usesDepartments(me);
  const departments = useDepartments({ enabled: showDepartments });
  const [chosenSite, setSiteFilter] = useState(ALL_SITES);
  const [chosenTeam, setTeamFilter] = useState(ALL_TEAMS);
  const [departmentFilter, setDepartmentFilter] = useState<DepartmentFilterValue>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | HoursStatus>('all');
  const sites = useMemo(() => siteChoices(data.data?.rows.map((r) => r.siteName) ?? []), [data.data]);
  // A site or team without rows in the month on screen falls back to all of them.
  const siteFilter = sites.some((s) => s.value === chosenSite) ? chosenSite : ALL_SITES;
  // Teams belong to a site, so they are offered once one is chosen.
  const teams = useMemo(
    () => (siteFilter === ALL_SITES ? [] : rowTeams(data.data?.rows.filter((r) => r.siteName === siteFilter) ?? [])),
    [data.data, siteFilter],
  );
  const teamFilter = teams.some((team) => team.key === chosenTeam) ? chosenTeam : ALL_TEAMS;
  const rows = useMemo(
    () =>
      data.data?.rows.filter(
        (r) =>
          (siteFilter === ALL_SITES || r.siteName === siteFilter) &&
          (teamFilter === ALL_TEAMS || rowTeamKey(r) === teamFilter) &&
          (!showDepartments || inDepartmentFilter(departmentFilter, r.departmentId, departments.data ?? [])) &&
          (statusFilter === 'all' || hoursStatus(r) === statusFilter),
      ),
    [data.data, siteFilter, teamFilter, showDepartments, departmentFilter, departments.data, statusFilter],
  );

  const columns = useMemo<ColumnDef<MonthlyHoursRow, unknown>[]>(
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
            <div>{row.original.siteName}</div>
            <div className="text-sm text-muted-foreground">{partDates(row.original, month, format.date, t)}</div>
            {row.original.shift && (
              <div className="text-sm text-muted-foreground">
                {t('workers.shiftWithHours', {
                  name: row.original.shift.name,
                  hours: format.number(row.original.shift.normalHoursPerDay),
                })}
              </div>
            )}
          </div>
        ),
      },
      {
        id: 'hours',
        header: t('monthlyHours.hours'),
        enableSorting: false,
        cell: ({ row }) => {
          const current = row.original.history[0];
          return current ? <HoursSummary entry={current} /> : '—';
        },
      },
      {
        id: 'status',
        header: t('workers.status'),
        enableSorting: false,
        cell: ({ row }) => {
          const status = hoursStatus(row.original);
          return <StatusBadge tone={STATUS_TONES[status]}>{t(`monthlyHours.${status}`)}</StatusBadge>;
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
            aria-label={t('monthlyHours.enterFor', { name: workerName(row.original.worker) })}
          >
            <Pencil aria-hidden />
          </Button>
        ),
      },
    ],
    [t, format, month],
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
        searchText={(r) => [workerSearchText(r.worker), r.siteName, r.teamName, r.shift?.name].filter(Boolean).join(' ')}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <MonthSwitcher value={month} onChange={setMonth} />
            <SiteFilter sites={sites} value={siteFilter} onChange={setSiteFilter} />
            {teams.length > 1 && <TeamFilter teams={teams} value={teamFilter} onChange={setTeamFilter} />}
            {showDepartments && (
              <DepartmentFilter departments={departments.data ?? []} value={departmentFilter} onChange={setDepartmentFilter} />
            )}
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
              <SelectTrigger className="w-full sm:w-44" aria-label={t('workers.status')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('workers.filterAll')}</SelectItem>
                {HOURS_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {t(`monthlyHours.${status}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {locked && <StatusBadge tone="neutral">{t('monthlyHours.locked')}</StatusBadge>}
          </div>
        }
        emptyTitle={t('monthlyHours.emptyTitle')}
        emptyDescription={t('monthlyHours.emptyDescription')}
      />
      {editing && (
        <HoursDialog
          // A fresh form for each placement and part opened
          key={`${editing.assignmentId}/${editing.part.from}`}
          month={month}
          row={editing}
          locked={locked}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            toast.success(t('common.saved'));
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: MONTHLY_HOURS_KEY }),
              queryClient.invalidateQueries({ queryKey: PAYROLL_KEY }),
            ]);
          }}
        />
      )}
    </>
  );
}

/**
 * The days the row's totals cover: "1.09.2026 – 14.09.2026" for a part of a shift change,
 * else when the placement starts or ends inside the month; empty for the whole month.
 */
function partDates(
  row: Pick<MonthlyHoursRow, 'part' | 'days'>,
  { year, month }: YearMonth,
  date: (value: string) => string,
  t: (key: string, options?: Record<string, string>) => string,
): string {
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  const last = `${year}-${String(month).padStart(2, '0')}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;
  const { days } = row;
  const split = row.part.from > first || row.part.until < last;
  const starts = days.from > first;
  const ends = days.until < last;
  if (split || (starts && ends)) return t('monthlyHours.fromUntil', { from: date(days.from), until: date(days.until) });
  if (starts) return t('monthlyHours.fromDay', { date: date(days.from) });
  if (ends) return t('monthlyHours.untilDay', { date: date(days.until) });
  return '';
}

/** Hours and days of an entry, leaving out what is zero. */
function HoursSummary({ entry }: { entry: MonthlyHoursEntry }) {
  const { t } = useTranslation();
  const format = useFormat();
  const parts = [
    ...HOUR_FIELDS.filter((f) => Number(entry[f]) !== 0).map((f) =>
      t(`monthlyHours.short.${f}`, { value: format.number(entry[f]) }),
    ),
    ...DAY_FIELDS.filter((f) => entry[f] !== 0).map((f) => t(`monthlyHours.short.${f}`, { count: entry[f] })),
  ];
  return <span className="text-sm tabular-nums">{parts.length > 0 ? parts.join(' · ') : t('monthlyHours.nothing')}</span>;
}

const EMPTY: Omit<MonthlyHoursInput, 'from' | 'until'> = {
  normalHours: '0',
  overtimeHours: '0',
  restDayHours: '0',
  holidayHours: '0',
  workdaysWorked: 0,
  leaveDays: 0,
  sickDays: 0,
  travelDays: 0,
  note: '',
};

/** Enter (or correct) a placement's hours for the month, and see what was entered before. */
function HoursDialog({
  month,
  row,
  locked,
  onClose,
  onSaved,
}: {
  month: YearMonth;
  row: MonthlyHoursRow;
  locked: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const [formError, setFormError] = useState<string>();
  const current = row.history[0];
  const form = useForm<MonthlyHoursInput, unknown, MonthlyHours>({
    resolver: zodResolver(monthlyHoursSchema),
    defaultValues: {
      ...(current ? { ...Object.fromEntries([...HOUR_FIELDS, ...DAY_FIELDS].map((f) => [f, current[f]])), note: '' } : EMPTY),
      // The part the totals are for; the API refuses them if the worker's shifts changed meanwhile.
      ...row.part,
    },
  });
  const { errors } = form.formState;
  const readOnly = locked || row.hasDailyEntries;

  const save = useMutation({
    mutationFn: (values: MonthlyHours) => api.post(`/monthly-hours/${month.year}/${month.month}/${row.assignmentId}`, values),
    onSuccess: onSaved,
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('monthlyHours.dialogTitle', { month: format.month(month.year, month.month) })}</DialogTitle>
          <DialogDescription>
            {[workerName(row.worker), row.siteName, partDates(row, month, format.date, t)].filter(Boolean).join(' · ')} ·{' '}
            {row.shift
              ? t('monthlyHours.dialogHintShift', { name: row.shift.name, hours: format.number(row.shift.normalHoursPerDay) })
              : t('monthlyHours.dialogHint')}
          </DialogDescription>
        </DialogHeader>
        {readOnly ? (
          <p className="text-sm text-muted-foreground">
            {locked ? t('monthlyHours.lockedHint') : t('monthlyHours.dailyEntriesHint')}
          </p>
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
            <fieldset className="space-y-3">
              <legend className="mb-1.5 text-sm font-medium">{t('monthlyHours.hoursWorked')}</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {HOUR_FIELDS.map((f) => (
                  <Field key={f} id={`mh-${f}`} label={t(`monthlyHours.field.${f}`)} error={errors[f]} hint={t(`monthlyHours.hint.${f}`)}>
                    <Input {...fieldControlProps(`mh-${f}`, errors[f])} {...form.register(f)} inputMode="decimal" autoComplete="off" />
                  </Field>
                ))}
              </div>
            </fieldset>
            <fieldset className="space-y-3">
              <legend className="mb-1.5 text-sm font-medium">{t('monthlyHours.days')}</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {DAY_FIELDS.map((f) => (
                  <Field key={f} id={`mh-${f}`} label={t(`monthlyHours.field.${f}`)} error={errors[f]} hint={t(`monthlyHours.hint.${f}`)}>
                    <Input
                      {...fieldControlProps(`mh-${f}`, errors[f])}
                      {...form.register(f, { valueAsNumber: true })}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={31}
                    />
                  </Field>
                ))}
              </div>
            </fieldset>
            <Field id="mh-note" label={t('monthlyHours.note')} error={errors.note} hint={t('monthlyHours.noteHint')}>
              <Input {...fieldControlProps('mh-note', errors.note)} {...form.register('note')} autoComplete="off" />
            </Field>
            <FormActions submitLabel={t('common.save')} pending={save.isPending} onCancel={onClose} />
          </form>
        )}
        {row.outdated.length > 0 && (
          <section className="space-y-2 border-t pt-4">
            <h3 className="text-sm font-medium">{t('monthlyHours.outdated')}</h3>
            <p className="text-sm text-muted-foreground">{t('monthlyHours.outdatedHint')}</p>
            <ul className="space-y-2 text-sm">
              {row.outdated.map((h) => (
                <li key={h.id} className="flex flex-col gap-0.5 text-muted-foreground">
                  <span>{t('monthlyHours.fromUntil', { from: format.date(h.part.from), until: format.date(h.part.until) })}</span>
                  <span className="line-through">
                    <HoursSummary entry={h} />
                  </span>
                  <span>
                    {h.setBy.fullName} · {format.date(h.setAt)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {row.history.length > 0 && (
          <section className="space-y-2 border-t pt-4">
            <h3 className="text-sm font-medium">{t('monthlyHours.history')}</h3>
            <ul className="space-y-2 text-sm">
              {row.history.map((h) => (
                <li key={h.id} className="flex flex-col gap-0.5">
                  <span className={h.corrected ? 'text-muted-foreground line-through' : undefined}>
                    <HoursSummary entry={h} />
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
