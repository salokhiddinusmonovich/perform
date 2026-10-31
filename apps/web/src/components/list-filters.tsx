import { useTranslation } from 'react-i18next';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/** "Every site"; can't be mistaken for a site, whose name may be any text. */
export const ALL_SITES = 'all-sites';
/** "Every team"; can't be mistaken for a team's key (an id, or NO_TEAM). */
export const ALL_TEAMS = 'all';

/** The site filter of lists. A site's value is its id, or its name where rows only carry names. */
export function SiteFilter({
  sites,
  value,
  onChange,
}: {
  sites: readonly { value: string; name: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full sm:w-48" aria-label={t('workers.site')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_SITES}>{t('workers.allSites')}</SelectItem>
        {sites.map((s) => (
          <SelectItem key={s.value} value={s.value}>
            {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The team filter of one site's rows; a null name is "no team". */
export function TeamFilter({
  teams,
  value,
  onChange,
}: {
  teams: readonly { key: string; name: string | null }[];
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full sm:w-48" aria-label={t('timesheet.team')}>
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
  );
}
