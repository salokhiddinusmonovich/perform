import type { PayLine } from '@puantaj/payroll';
import type { YearMonth } from '@puantaj/schemas';
import type { ColumnDef } from '@tanstack/react-table';
import { FileText } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { DataTable } from '@/components/data-table';
import { MonthSwitcher } from '@/components/month-switcher';
import { PageHeader } from '@/components/page-header';
import { RequireAccess } from '@/components/require-access';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useFormat } from '@/hooks/use-format';
import { canEnterMonthlyHours, seesPay, useMe } from '@/lib/auth';
import { workerName } from '@/lib/organisation';
import { currentMonth, usePayroll, type PayrollPart, type PayrollProblem, type PayrollWorker } from '@/lib/payroll';

export function PayrollPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('payroll.title')} description={t('payroll.description')} />
      <RequireAccess allowed={seesPay}>{(me) => <PayrollView currency={me.activeCompany!.currency} />}</RequireAccess>
    </>
  );
}

function PayrollView({ currency }: { currency: string }) {
  const { t } = useTranslation();
  const format = useFormat();
  const [month, setMonth] = useState<YearMonth>(currentMonth);
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

  return (
    <>
      {data.data && (
        <Card className="mb-4">
          <CardHeader>
            <CardDescription>{t('payroll.totalFor', { month: format.month(month.year, month.month) })}</CardDescription>
            <CardTitle className="tabular-nums">{format.money(data.data.total, currency)}</CardTitle>
          </CardHeader>
          {(withProblems > 0 || data.data.locked) && (
            <CardContent className="flex flex-wrap gap-2">
              {data.data.locked && <StatusBadge tone="neutral">{t('monthlyHours.locked')}</StatusBadge>}
              {withProblems > 0 && (
                <StatusBadge tone="warning">{t('payroll.workersWithProblems', { count: withProblems })}</StatusBadge>
              )}
            </CardContent>
          )}
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
      {open && <PayslipDialog worker={open} month={month} currency={currency} onClose={() => setOpen(null)} />}
    </>
  );
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
