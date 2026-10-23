import { zodResolver } from '@hookform/resolvers/zod';
import type { PayLine } from '@puantaj/payroll';
import { unlockSchema, type Unlock, type UnlockInput, type YearMonth } from '@puantaj/schemas';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { FileText, Lock, LockOpen } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable } from '@/components/data-table';
import { Field, fieldControlProps, FormActions, FormError } from '@/components/form';
import { MonthSwitcher } from '@/components/month-switcher';
import { PageHeader } from '@/components/page-header';
import { RequireAccess } from '@/components/require-access';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useFormat } from '@/hooks/use-format';
import { api } from '@/lib/api';
import { canEnterMonthlyHours, canLockMonths, canUnlockMonths, seesPay, useMe, type Me } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { workerName } from '@/lib/organisation';
import {
  currentMonth,
  MONTHLY_HOURS_KEY,
  PAYROLL_KEY,
  usePayroll,
  type LockItem,
  type PayrollMonth,
  type PayrollPart,
  type PayrollProblem,
  type PayrollWorker,
} from '@/lib/payroll';

export function PayrollPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('payroll.title')} description={t('payroll.description')} />
      <RequireAccess allowed={seesPay}>{(me) => <PayrollView me={me} />}</RequireAccess>
    </>
  );
}

function PayrollView({ me }: { me: Me }) {
  const { t } = useTranslation();
  const format = useFormat();
  const queryClient = useQueryClient();
  const currency = me.activeCompany!.currency;
  const [month, setMonth] = useState<YearMonth>(currentMonth);
  const [locking, setLocking] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [open, setOpen] = useState<PayrollWorker | null>(null);
  const data = usePayroll(month);
  const withProblems = data.data?.workers.filter((w) => w.problems.length > 0).length ?? 0;

  const columns = useMemo<ColumnDef<PayrollWorker, unknown>[]>(
    () => [
      {
        id: 'name',
        accessorFn: (w) => workerName(w.worker),
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
        id: 'salary',
        accessorFn: (w) => (w.salary ? Number(w.salary.monthlySalary) : -1),
        header: t('workers.salary'),
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.salary ? format.money(row.original.salary.monthlySalary, currency) : '—'}
          </span>
        ),
      },
      {
        id: 'source',
        header: t('payroll.source'),
        enableSorting: false,
        cell: ({ row }) =>
          row.original.source ? (
            <StatusBadge tone="info">{t(`payroll.sources.${row.original.source}`)}</StatusBadge>
          ) : (
            '—'
          ),
      },
      {
        id: 'total',
        accessorFn: (w) => (w.total === null ? -1 : Number(w.total)),
        header: t('payroll.pay'),
        cell: ({ row }) =>
          row.original.total !== null ? (
            <span className="font-semibold tabular-nums">{format.money(row.original.total, currency)}</span>
          ) : (
            <StatusBadge tone="warning">{t('payroll.problemCount', { count: row.original.problems.length })}</StatusBadge>
          ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{t('common.actions')}</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <Button variant="ghost" size="icon" onClick={() => setOpen(row.original)} aria-label={t('payroll.detailsFor', { name: workerName(row.original.worker) })}>
            <FileText aria-hidden />
          </Button>
        ),
      },
    ],
    [t, format, currency],
  );

  const monthName = format.month(month.year, month.month);
  /** After locking or unlocking: payroll, hours and settings pages show the month's state. */
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: PAYROLL_KEY }),
      queryClient.invalidateQueries({ queryKey: MONTHLY_HOURS_KEY }),
      queryClient.invalidateQueries({ queryKey: ['working-days'] }),
    ]);

  return (
    <>
      {data.data && (
        <Card className="mb-4">
          <CardHeader>
            <CardDescription>{t('payroll.totalFor', { month: monthName })}</CardDescription>
            <CardTitle className="tabular-nums">{format.money(data.data.total, currency)}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {data.data.locked ? (
                <StatusBadge tone="neutral">{t('monthlyHours.locked')}</StatusBadge>
              ) : (
                <StatusBadge tone="info">{t('payroll.open')}</StatusBadge>
              )}
              {withProblems > 0 && (
                <StatusBadge tone="warning">{t('payroll.workersWithProblems', { count: withProblems })}</StatusBadge>
              )}
            </div>
            <LockActions
              me={me}
              month={data.data}
              withProblems={withProblems}
              onLock={() => setLocking(true)}
              onUnlock={() => setUnlocking(true)}
            />
          </CardContent>
        </Card>
      )}
      <DataTable
        columns={columns}
        data={data.data?.workers}
        isLoading={data.isPending}
        isError={data.isError}
        onRetry={() => data.refetch()}
        toolbar={<MonthSwitcher value={month} onChange={setMonth} />}
        emptyTitle={t('payroll.emptyTitle')}
        emptyDescription={t('payroll.emptyDescription')}
      />
      {data.data && data.data.locks.length > 0 && <LockHistory locks={data.data.locks} currency={currency} />}
      {open && <PayslipDialog worker={open} month={month} currency={currency} onClose={() => setOpen(null)} />}
      {data.data && (
        <ConfirmDialog
          open={locking}
          onOpenChange={setLocking}
          title={t('payroll.lockTitle', { month: monthName })}
          description={t('payroll.lockDescription', {
            month: monthName,
            count: data.data.workers.length,
            total: format.money(data.data.total, currency),
          })}
          confirmLabel={t('payroll.lock')}
          onConfirm={async () => {
            await api.post(`/payroll/${month.year}/${month.month}/lock`);
            toast.success(t('payroll.lockedToast', { month: monthName }));
            await refresh();
          }}
        />
      )}
      {unlocking && (
        <UnlockDialog
          month={month}
          onClose={() => setUnlocking(false)}
          onSaved={async () => {
            setUnlocking(false);
            toast.success(t('payroll.unlockedToast', { month: monthName }));
            await refresh();
          }}
        />
      )}
    </>
  );
}

/** Lock or unlock the month, or say why it can't be locked yet. */
function LockActions({
  me,
  month,
  withProblems,
  onLock,
  onUnlock,
}: {
  me: Me;
  month: PayrollMonth;
  withProblems: number;
  onLock: () => void;
  onUnlock: () => void;
}) {
  const { t } = useTranslation();
  if (month.locked) {
    return canUnlockMonths(me) ? (
      <Button variant="outline" onClick={onUnlock}>
        <LockOpen aria-hidden />
        {t('payroll.unlock')}
      </Button>
    ) : (
      <p className="text-sm text-muted-foreground">{t('payroll.lockedHint')}</p>
    );
  }
  if (!canLockMonths(me)) return null;
  const blocked = !month.ended ? t('payroll.lockAfterEnd') : withProblems > 0 ? t('payroll.lockNeedsAll') : null;
  return (
    <div className="space-y-1.5">
      <Button onClick={onLock} disabled={blocked !== null}>
        <Lock aria-hidden />
        {t('payroll.lock')}
      </Button>
      <p className="text-sm text-muted-foreground">{blocked ?? t('payroll.lockHint')}</p>
    </div>
  );
}

/** Reopening a locked month needs a reason, which goes into the audit log. */
function UnlockDialog({ month, onClose, onSaved }: { month: YearMonth; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const format = useFormat();
  const [formError, setFormError] = useState<string>();
  const form = useForm<UnlockInput, unknown, Unlock>({ resolver: zodResolver(unlockSchema), defaultValues: { reason: '' } });
  const save = useMutation({
    mutationFn: (values: Unlock) => api.post(`/payroll/${month.year}/${month.month}/unlock`, values),
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
          <DialogTitle>{t('payroll.unlockTitle', { month: format.month(month.year, month.month) })}</DialogTitle>
          <DialogDescription>{t('payroll.unlockHint')}</DialogDescription>
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
          <Field id="unlock-reason" label={t('payroll.unlockReason')} error={error}>
            <Input {...fieldControlProps('unlock-reason', error)} {...form.register('reason')} autoComplete="off" />
          </Field>
          <FormActions submitLabel={t('payroll.unlock')} pending={save.isPending} onCancel={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Every lock of the month, what changed since the lock before, and why it was reopened. */
function LockHistory({ locks, currency }: { locks: LockItem[]; currency: string }) {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>{t('payroll.lockHistory')}</CardTitle>
        <CardDescription>{t('payroll.lockHistoryHint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="space-y-4 text-sm">
          {[...locks].reverse().map((lock) => (
            <li key={lock.lockNumber} className="space-y-2 border-b pb-4 last:border-b-0 last:pb-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  {t('payroll.lockNumber', { number: lock.lockNumber })} ·{' '}
                  <span className="tabular-nums">{format.money(lock.total, currency)}</span>
                </span>
                <span className="text-muted-foreground">
                  {lock.lockedBy.fullName} · {format.date(lock.lockedAt)} {format.time(lock.lockedAt)}
                </span>
              </div>
              {lock.changes !== null &&
                (lock.changes.length === 0 ? (
                  <p className="text-muted-foreground">{t('payroll.noChanges')}</p>
                ) : (
                  <ul className="divide-y rounded-md border">
                    {lock.changes.map((c) => (
                      <li key={c.worker.id} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2">
                        <span>{workerName(c.worker)}</span>
                        <span className="tabular-nums">
                          {c.before === null ? t('payroll.notInLock') : format.money(c.before, currency)} →{' '}
                          {c.after === null ? t('payroll.notInLock') : format.money(c.after, currency)}
                          {c.difference !== null && (
                            <span className="ms-2 text-muted-foreground">
                              ({signedMoney(c.difference, (v) => format.money(v, currency))})
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                ))}
              {lock.unlocked && (
                <p>
                  <StatusBadge tone="warning">{t('payroll.unlockedBadge')}</StatusBadge>{' '}
                  <span className="text-muted-foreground">
                    {lock.unlocked.by?.fullName} · {format.date(lock.unlocked.at)} · {lock.unlocked.reason}
                  </span>
                </p>
              )}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

/** "+300 000 soʻm" or "−300 000 soʻm" from the API's difference (a decimal string). */
function signedMoney(difference: string, money: (value: string) => string): string {
  return difference.startsWith('-') ? `−${money(difference.slice(1))}` : `+${money(difference)}`;
}

/** One worker's month: every amount with the hours, rate and rule it came from. */
function PayslipDialog({
  worker,
  month,
  currency,
  onClose,
}: {
  worker: PayrollWorker;
  month: YearMonth;
  currency: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const me = useMe().data;
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{workerName(worker.worker)}</DialogTitle>
          <DialogDescription>
            {format.month(month.year, month.month)}
            {worker.source && ` · ${t(`payroll.sources.${worker.source}`)}`}
          </DialogDescription>
        </DialogHeader>
        {worker.problems.length > 0 ? (
          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t('payroll.cannotPay')}</h3>
            <ul className="space-y-2 text-sm">
              {worker.problems.map((p, i) => (
                <li key={i}>
                  <ProblemText problem={p} />
                </li>
              ))}
            </ul>
            {canEnterMonthlyHours(me) && (
              <Link to="/monthly-hours" className="text-sm underline underline-offset-4">
                {t('payroll.goToMonthlyHours')}
              </Link>
            )}
          </section>
        ) : (
          <>
            {worker.parts.map((part, i) => (
              <PartView key={i} part={part} currency={currency} showRules={worker.parts.length > 1 || part.ruleSetSiteName !== null} />
            ))}
            <div className="flex items-baseline justify-between border-t pt-4">
              <span className="font-medium">{t('payroll.monthTotal')}</span>
              <span className="text-lg font-semibold tabular-nums">{format.money(worker.total!, currency)}</span>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ProblemText({ problem }: { problem: PayrollProblem }) {
  const { t } = useTranslation();
  const format = useFormat();
  switch (problem.code) {
    case 'placementWithoutHours':
      return t('payroll.problems.placementWithoutHours', { site: problem.siteName, date: format.date(problem.from) });
    case 'noRules':
      return t('payroll.problems.noRules', { sites: problem.siteNames.join(', ') });
    case 'totalsInvalid':
      return (
        <>
          {t('payroll.problems.totalsInvalid')}
          <ul className="mt-1 list-disc ps-5 text-muted-foreground">
            {problem.issues.map((issue, i) => (
              <li key={i}>
                {issue.siteName ? `${issue.siteName}: ` : `${t('payroll.allPlacements')}: `}
                {t(`payroll.totalsProblems.${issue.problem}`)}
              </li>
            ))}
          </ul>
        </>
      );
    case 'invalidHours':
      return (
        <>
          {t('payroll.problems.invalidHours')}
          <span className="block text-muted-foreground">{problem.detail}</span>
        </>
      );
    default:
      return t(`payroll.problems.${problem.code}`);
  }
}

function PartView({ part, currency, showRules }: { part: PayrollPart; currency: string; showRules: boolean }) {
  const { t } = useTranslation();
  const format = useFormat();
  const { result } = part;
  const rate = result.hourlyRate;
  const places = Object.keys(part.places);
  const placeName = (key: string) => {
    const p = part.places[key];
    if (!p) return key;
    return p.from ? `${p.siteName} (${t('monthlyHours.fromDay', { date: format.date(p.from) })})` : p.siteName;
  };

  const describe = (line: PayLine): string => {
    switch (line.type) {
      case 'HOURS':
        return t('payroll.lines.hours', {
          kind: t(`payroll.hourKinds.${line.kind}`),
          hours: format.number(line.hours),
          multiplier: format.number(line.multiplier),
        });
      case 'ABSENCE':
        return line.paid
          ? t('payroll.lines.absencePaid', {
              absence: t(`payroll.absences.${line.absence}`),
              count: line.days,
              hours: format.number(line.hoursPerDay),
            })
          : t('payroll.lines.absenceUnpaid', { absence: t(`payroll.absences.${line.absence}`), count: line.days });
      case 'TRAVEL_PER_DAY':
        return line.route
          ? t('payroll.lines.travelPerDay', { route: line.route, count: line.days, amount: format.money(line.amountPerDay, currency) })
          : t('payroll.lines.travelNoRoute', { count: line.days });
      case 'TRAVEL_MONTHLY':
        return t('payroll.lines.travelMonthly');
      case 'ROUNDING':
        return t('payroll.lines.rounding', { step: format.money(line.step, currency) });
    }
  };

  return (
    <section className="space-y-3">
      {showRules && (
        <h3 className="text-sm font-medium">
          {part.ruleSetSiteName
            ? t('payroll.siteRules', { site: part.ruleSetSiteName })
            : t('payroll.defaultRules')}
        </h3>
      )}
      <p className="text-sm text-muted-foreground">
        {t('payroll.hourlyRate', {
          salary: format.money(rate.monthlySalary, currency),
          days: rate.workingDays.effective,
          hours: format.number(rate.normalHoursPerDay),
          rate: format.money(rate.rounded, currency),
        })}
        {rate.workingDays.override !== null &&
          ` ${t('payroll.workingDaysOverridden', { calculated: rate.workingDays.calculated })}`}
      </p>
      <ul className="divide-y rounded-md border text-sm">
        {result.lines.map((line, i) => (
          <li key={i} className="flex items-start justify-between gap-4 px-3 py-2">
            <span>
              {'place' in line && places.length > 1 && (
                <span className="block text-muted-foreground">{placeName(line.place)}</span>
              )}
              {describe(line)}
            </span>
            <span className="shrink-0 tabular-nums">{format.money(line.amount, currency)}</span>
          </li>
        ))}
      </ul>
      {showRules && (
        <div className="flex justify-between text-sm">
          <span>{t('payroll.partTotal')}</span>
          <span className="font-medium tabular-nums">{format.money(result.total, currency)}</span>
        </div>
      )}
    </section>
  );
}
