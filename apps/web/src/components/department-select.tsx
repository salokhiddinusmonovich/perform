import { useTranslation } from 'react-i18next';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { departmentTree, withSubDepartments, type DepartmentItem } from '@/lib/organisation';

/** Radix Select can't hold an empty value, so "none" has its own. */
const NONE = 'none';

/**
 * Picks a department from the company's tree, each shown with its path ("HSE › HSE Site A")
 * so sub-departments with the same name can be told apart. Offers active departments, plus
 * `keep` (the one already chosen) even if it was closed since.
 */
export function DepartmentSelect({
  id,
  departments,
  value,
  onChange,
  keep,
  exclude,
  noneLabel,
  invalid,
  disabled,
}: {
  id: string;
  departments: readonly DepartmentItem[];
  /** A department id, or '' for none */
  value: string;
  onChange: (value: string) => void;
  keep?: string | null;
  /** Departments not to offer (e.g. a department and its own sub-departments, as its parent) */
  exclude?: ReadonlySet<string>;
  /** Offers "none" with this label (e.g. no department yet); without it a department must be picked */
  noneLabel?: string;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const offered = departmentTree(departments).filter(
    (d) => (d.isActive || d.id === keep || d.id === value) && !exclude?.has(d.id),
  );
  return (
    <Select value={value || (noneLabel ? NONE : '')} onValueChange={(v) => onChange(v === NONE ? '' : v)} disabled={disabled}>
      <SelectTrigger id={id} className="w-full" aria-invalid={invalid ? true : undefined}>
        <SelectValue placeholder={t('departments.choose')} />
      </SelectTrigger>
      <SelectContent>
        {noneLabel && <SelectItem value={NONE}>{noneLabel}</SelectItem>}
        {offered.map((d) => (
          <SelectItem key={d.id} value={d.id}>
            {d.path}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A department filter: every department, those with none yet, or one department with its sub-departments. */
export type DepartmentFilterValue = 'all' | 'none' | (string & {});

/** Does a row in `departmentId` (null: none) pass the filter? A department includes its sub-departments. */
export function inDepartmentFilter(
  filter: DepartmentFilterValue,
  departmentId: string | null | undefined,
  departments: readonly DepartmentItem[],
): boolean {
  if (filter === 'all') return true;
  if (filter === 'none') return !departmentId;
  return Boolean(departmentId) && withSubDepartments(departments, filter).has(departmentId!);
}

/** The department filter of lists (workers, payroll), next to their other filters. */
export function DepartmentFilter({
  departments,
  value,
  onChange,
}: {
  departments: readonly DepartmentItem[];
  value: DepartmentFilterValue;
  onChange: (value: DepartmentFilterValue) => void;
}) {
  const { t } = useTranslation();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full sm:w-56" aria-label={t('departments.department')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{t('departments.all')}</SelectItem>
        <SelectItem value="none">{t('departments.none')}</SelectItem>
        {departmentTree(departments).map((d) => (
          <SelectItem key={d.id} value={d.id}>
            {d.path}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
