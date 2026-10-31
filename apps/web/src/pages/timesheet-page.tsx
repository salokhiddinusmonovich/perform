import { GRID_CODE_STATUSES, type YearMonth } from '@puantaj/schemas';
import { CalendarX, Info, MapPin, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { LoadingState } from '@/components/loading-state';
import { MonthSwitcher } from '@/components/month-switcher';
import { PageHeader } from '@/components/page-header';
import { RequireAccess } from '@/components/require-access';
import { StatusBadge } from '@/components/status-badge';
import { TimesheetGrid } from '@/components/timesheet-grid';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { canManageCompany, hasTimesheet, type Me } from '@/lib/auth';
import { useSites } from '@/lib/organisation';
import { currentMonth } from '@/lib/payroll';
import { rowTeamKey, rowTeams, useTimesheet, useTimesheetCodes, type TimesheetCodeItem, type TimesheetMonth } from '@/lib/timesheet';

const ALL_TEAMS = 'all';

export function TimesheetPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('timesheet.title')} description={t('timesheet.description')} />
      <RequireAccess allowed={hasTimesheet}>{(me) => <TimesheetView me={me} />}</RequireAccess>
    </>
  );
}

function TimesheetView({ me }: { me: Me }) {
  const { t } = useTranslation();
  const [month, setMonth] = useState<YearMonth>(currentMonth);
  const sites = useSites();
  const [chosenSite, setChosenSite] = useState<string | null>(null);
  // Open sites, and a closed one only while it is chosen (its past months stay readable).
  const choices = sites.data?.filter((s) => s.isActive || s.id === chosenSite) ?? [];
  const siteId = chosenSite ?? choices[0]?.id ?? null;
  const data = useTimesheet(month, siteId);
  const codes = useTimesheetCodes();
  const [chosenTeam, setChosenTeam] = useState(ALL_TEAMS);
  const loaded = data.data;
  const teams = useMemo(() => rowTeams(loaded?.rows ?? []), [loaded]);
  // A team without rows in the month on screen falls back to everyone.
  const teamKey = teams.some((team) => team.key === chosenTeam) ? chosenTeam : ALL_TEAMS;
  const shown = useMemo(
    () => loaded && (teamKey === ALL_TEAMS ? loaded : { ...loaded, rows: loaded.rows.filter((r) => rowTeamKey(r) === teamKey) }),
    [loaded, teamKey],
  );

  const chooseSite = (id: string) => {
    setChosenSite(id);
    setChosenTeam(ALL_TEAMS);
  };

  if (sites.isPending || codes.isPending) return <LoadingState />;
  if (sites.isError) return <ErrorState onRetry={() => sites.refetch()} />;
  if (codes.isError) return <ErrorState onRetry={() => codes.refetch()} />;
  if (choices.length === 0) {
    return <EmptyState icon={MapPin} title={t('timesheet.noSitesTitle')} description={t('timesheet.noSitesDescription')} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <MonthSwitcher value={month} onChange={setMonth} />
        <Select value={siteId ?? ''} onValueChange={chooseSite}>
          <SelectTrigger className="w-full sm:w-64" aria-label={t('timesheet.site')}>
            <SelectValue placeholder={t('timesheet.chooseSite')} />
          </SelectTrigger>
          <SelectContent>
            {choices.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {teams.length > 1 && (
          <Select value={teamKey} onValueChange={setChosenTeam}>
            <SelectTrigger className="w-full sm:w-64" aria-label={t('timesheet.team')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_TEAMS}>{t('timesheet.allTeams')}</SelectItem>
              {teams.map((team) => (
                <SelectItem key={team.key} value={team.key}>
                  {team.name ?? t('timesheet.noTeam')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {data.data?.locked &&<StatusBadge tone="neutral">{t('timesheet.locked')}</StatusBadge>}
      </div>
      {data.isError ? (
        <ErrorState onRetry={() => data.refetch()} />
      ) : shown ? (
        <MonthView data={shown} codes={codes.data} me={me} />
      ) : (
        <LoadingState />
      )}
    </div>
  );
}

function MonthView({ data, codes, me }: { data: TimesheetMonth; codes: TimesheetCodeItem[]; me: Me }) {
  const { t } = useTranslation();
  // The code each absence shows with; statuses without one can't be typed yet.
  const shown = GRID_CODE_STATUSES.flatMap((s) => codes.filter((c) => c.status === s && c.inGrid));
  if (data.rows.length === 0) {
    return <EmptyState icon={CalendarX} title={t('timesheet.emptyTitle')} description={t('timesheet.emptyDescription')} />;
  }
  const canEnter = data.rows.some((r) => r.canEnter);
  const withTotals = data.rows.some((r) => r.hasMonthlyTotals);
  const withImport = data.rows.some((r) => r.hasImportedHours);
  const importEditable = data.rows.some((r) => r.hasImportedHours && r.canEnter);
  const withEdits = data.rows.some((r) => r.editedDays.length > 0);
  return (
    <>
      {data.calendar === null && (
        <Alert variant="warning">
          <TriangleAlert aria-hidden />
          <AlertTitle>{t('timesheet.noRulesTitle')}</AlertTitle>
          <AlertDescription>{t('timesheet.noRulesDescription')}</AlertDescription>
        </Alert>
      )}
      {(data.locked || !canEnter || withTotals || withImport) && (
        <Alert>
          <Info aria-hidden />
          <AlertDescription>
            {data.locked
              ? t('timesheet.lockedHint')
              : !data.timesheetModule
                ? t('timesheet.moduleOffHint')
                : withImport
                  ? t(importEditable ? 'timesheet.importedEditHint' : 'timesheet.importedHint')
                  : !canEnter
                    ? t('timesheet.readOnlyHint')
                    : t('timesheet.monthlyTotalsHint')}
          </AlertDescription>
        </Alert>
      )}
      {canEnter && shown.length < GRID_CODE_STATUSES.length && (
        <Alert>
          <Info aria-hidden />
          <AlertTitle>{t('timesheet.codesMissingTitle')}</AlertTitle>
          <AlertDescription>
            <p>{canManageCompany(me) ? t('timesheet.codesMissingManager') : t('timesheet.codesMissingMember')}</p>
            {canManageCompany(me) && (
              <Link to="/settings/codes" className="font-medium underline underline-offset-4">
                {t('timesheet.goToCodes')}
              </Link>
            )}
          </AlertDescription>
        </Alert>
      )}
      <TimesheetGrid data={data} codes={codes} myName={me.user.fullName} />
      <section aria-labelledby="timesheet-legend" className="space-y-1 text-sm text-muted-foreground">
        <h2 id="timesheet-legend" className="font-medium text-foreground">
          {t('timesheet.legendTitle')}
        </h2>
        {canEnter && <p>{t('timesheet.howToEnter')}</p>}
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          {shown.map((c) => (
            <li key={c.status}>
              <span className="font-semibold text-foreground">{c.code}</span> — {t(`timesheet.status.${c.status}`)}
            </li>
          ))}
          <li>
            <span className="font-semibold text-foreground">–</span> — {t('timesheet.notEmployed')}
          </li>
          {withEdits && (
            <li>
              <span className="font-semibold text-foreground underline decoration-dotted underline-offset-4">9</span> —{' '}
              {t('timesheet.editedByHand')}
            </li>
          )}
        </ul>
      </section>
    </>
  );
}
