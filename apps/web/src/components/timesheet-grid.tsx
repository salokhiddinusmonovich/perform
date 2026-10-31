import { normalizeCode, type DayKind } from '@puantaj/payroll';
import { dayHoursSchema, GRID_CODE_STATUSES, type EntryStatus } from '@puantaj/schemas';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CellStyleModule,
  ClientSideRowModelModule,
  TextEditorModule,
  themeQuartz,
  TooltipModule,
  ValidationModule,
  type CellClassParams,
  type ColDef,
  type EditableCallbackParams,
  type Module,
  type TooltipCallbackParams,
  type ValueGetterParams,
  type ValueSetterParams,
} from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useFormat } from '@/hooks/use-format';
import { ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { isoWeekday } from '@/lib/format';
import { workerName } from '@/lib/organisation';
import { MONTHLY_HOURS_KEY, PAYROLL_KEY } from '@/lib/payroll';
import {
  deleteEntry,
  employedOn,
  monthDays,
  putEntry,
  timesheetKey,
  type TimesheetCodeItem,
  type TimesheetEntryItem,
  type TimesheetMonth,
  type TimesheetRow,
} from '@/lib/timesheet';
import { cn } from '@/lib/utils';

// Only what the grid uses (pinned columns, keyboard navigation and ARIA are in its core),
// so the timesheet page stays small on phones. The validation
// module explains misconfigurations in development and is left out of production.
const MODULES: Module[] = [
  ClientSideRowModelModule,
  TextEditorModule,
  CellStyleModule,
  TooltipModule,
  ...(import.meta.env.DEV ? [ValidationModule] : []),
];

/** AG Grid styled with the app's design tokens, so it follows the theme (light and dark). */
const GRID_THEME = themeQuartz.withParams({
  backgroundColor: 'var(--card)',
  foregroundColor: 'var(--card-foreground)',
  chromeBackgroundColor: 'var(--muted)',
  headerBackgroundColor: 'var(--muted)',
  headerTextColor: 'var(--foreground)',
  subtleTextColor: 'var(--muted-foreground)',
  borderColor: 'var(--border)',
  accentColor: 'var(--ring)',
  rowHoverColor: 'var(--accent)',
  fontFamily: 'inherit',
  fontSize: 14,
  headerFontWeight: 500,
  rowHeight: 44,
  headerHeight: 48,
  // The page shows its own empty state, so no blank space is kept below the last row.
  autoHeightMinBodyHeight: 0,
  cellHorizontalPadding: 6,
  wrapperBorderRadius: 'var(--radius)',
  borderRadius: 'var(--radius)',
});

/** A row of the grid: the API's row and its entries by day. */
interface GridRow {
  key: string;
  row: TimesheetRow;
  /** Entry per day; null while an optimistic removal is saved */
  cells: Record<string, TimesheetEntryItem | null>;
  /** Days whose change is being saved */
  pending: ReadonlySet<string>;
}

/** What a typed cell means: hours worked, a status, or nothing (remove the entry). */
type CellInput = { status: EntryStatus; hours: string } | { clear: true };

/** Shown on days the worker isn't employed (no entry can be made). */
const NOT_EMPLOYED = '–';

const rowKey = (r: Pick<TimesheetRow, 'worker' | 'teamId'>) => `${r.worker.id}:${r.teamId ?? ''}`;

interface TimesheetGridProps {
  data: TimesheetMonth;
  /** The company's own codes */
  codes: TimesheetCodeItem[];
  /** Name shown on optimistic entries until the API answers */
  myName: string;
}

/**
 * A site's month: one row per worker and team, one column per day. A cell takes hours
 * ("9", "7,5"), one of the company's codes for an absence, or nothing to remove the entry. Each
 * change is saved at once; a stale or refused change is shown and the month reloaded.
 */
export function TimesheetGrid({ data, codes: companyCodes, myName }: TimesheetGridProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const queryClient = useQueryClient();
  const key = timesheetKey({ year: data.year, month: data.month }, data.site.id);
  const days = useMemo(() => monthDays({ year: data.year, month: data.month }), [data.year, data.month]);
  const kinds = useMemo(() => new Map(data.calendar?.map((d) => [d.date, d.kind]) ?? []), [data.calendar]);
  // Changes being saved, by row and day: shown at once, replaced by the API's answer.
  const [optimistic, setOptimistic] = useState<ReadonlyMap<string, TimesheetEntryItem | null>>(new Map());

  /** The company's codes typed in the grid, e.g. "IZ" → LEAVE, and the one shown per status. */
  const { codes, shown } = useMemo(() => {
    const grid = companyCodes.flatMap((c) => {
      const status = GRID_CODE_STATUSES.find((s) => s === c.status);
      return status ? [{ ...c, status }] : [];
    });
    return {
      codes: new Map(grid.map((c) => [normalizeCode(c.code), c.status] as const)),
      shown: new Map<string, string>(grid.filter((c) => c.inGrid).map((c) => [c.status, c.code])),
    };
  }, [companyCodes]);

  const rows = useMemo<GridRow[]>(
    () =>
      data.rows.map((r) => {
        const k = rowKey(r);
        const cells: GridRow['cells'] = Object.fromEntries(r.entries.map((e) => [e.date, e]));
        const pending = new Set<string>();
        for (const [cellKey, entry] of optimistic) {
          const [rk, day] = cellKey.split('|');
          if (rk !== k) continue;
          cells[day] = entry;
          pending.add(day);
        }
        return { key: k, row: r, cells, pending };
      }),
    [data.rows, optimistic],
  );

  const { mutate: save } = useMutation({
    mutationFn: async ({ row, day, input }: { row: TimesheetRow; day: string; input: CellInput }) => {
      const existing = row.entries.find((e) => e.date === day);
      if ('clear' in input) {
        if (existing) await deleteEntry(existing.id, existing.version);
        return null;
      }
      return putEntry(existing?.id ?? crypto.randomUUID(), {
        workerId: row.worker.id,
        siteId: data.site.id,
        teamId: row.teamId,
        date: day,
        status: input.status,
        hours: input.hours,
        note: existing?.note ?? null,
        version: existing?.version,
      });
    },
    onSuccess: (entry, { row, day }) => {
      queryClient.setQueryData<TimesheetMonth>(key, (old) =>
        old && {
          ...old,
          rows: old.rows.map((r) =>
            rowKey(r) !== rowKey(row)
              ? r
              : { ...r, entries: [...r.entries.filter((e) => e.date !== day), ...(entry ? [entry] : [])] },
          ),
        },
      );
    },
    onError: async (error) => {
      toast.error(
        error instanceof ApiError && error.code === 'validation' && error.issues[0]
          ? t(error.issues[0].message)
          : errorMessage(t, error),
      );
      // Someone else may have changed the month meanwhile: show what is saved now.
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onSettled: async (_, __, { row, day }) => {
      setOptimistic((old) => {
        const next = new Map(old);
        next.delete(`${rowKey(row)}|${day}`);
        return next;
      });
      await Promise.all([
        // The API keeps track of the days changed by hand in an imported month.
        ...(row.hasImportedHours ? [queryClient.invalidateQueries({ queryKey: key })] : []),
        queryClient.invalidateQueries({ queryKey: PAYROLL_KEY }),
        queryClient.invalidateQueries({ queryKey: MONTHLY_HOURS_KEY }),
      ]);
    },
  });

  const columns = useMemo<ColDef<GridRow>[]>(() => {
    /** Text a cell shows (and starts editing with). */
    const cellText = (entry: TimesheetEntryItem | null | undefined) => {
      if (!entry) return '';
      if (entry.status === 'WORKED') return format.number(entry.hours);
      // A status whose code was removed since shows by name.
      return shown.get(entry.status) ?? t(`timesheet.status.${entry.status}`);
    };
    const parse = (text: unknown): CellInput | null => {
      const value = typeof text === 'string' ? text.trim() : '';
      if (value === '') return { clear: true };
      const status = codes.get(normalizeCode(value));
      if (status) return { status, hours: '0' };
      const hours = dayHoursSchema.safeParse(value);
      return hours.success ? { status: 'WORKED', hours: hours.data } : null;
    };
    const open = (r: GridRow, day: string) =>
      r.row.canEnter && !r.row.hasMonthlyTotals && employedOn(r.row, day) && !r.pending.has(day);

    const dayColumn = (day: string): ColDef<GridRow> => {
      const kind: DayKind = kinds.get(day) ?? 'WORKDAY';
      const offDay = kind !== 'WORKDAY';
      return {
        colId: day,
        headerName: String(Number(day.slice(8))),
        headerComponentParams: { weekday: format.weekdayShort(isoWeekday(day)), offDay: offDay ? t(`timesheet.dayKind.${kind}`) : undefined },
        headerTooltip: [format.date(day), format.weekday(isoWeekday(day)), offDay ? t(`timesheet.dayKind.${kind}`) : null]
          .filter(Boolean)
          .join(' · '),
        headerClass: offDay ? 'bg-accent' : undefined,
        width: 56,
        minWidth: 56,
        sortable: false,
        suppressMovable: true,
        valueGetter: (p: ValueGetterParams<GridRow>) =>
          p.data && !p.data.cells[day] && !employedOn(p.data.row, day) ? NOT_EMPLOYED : cellText(p.data?.cells[day]),
        // A cell's look depends on more than its text (being saved, open for entry), so
        // it is redrawn whenever its row changes, not only when the text does.
        equals: () => false,
        editable: (p: EditableCallbackParams<GridRow>) => (p.data ? open(p.data, day) : false),
        cellEditor: 'agTextCellEditor',
        cellEditorParams: { maxLength: 5 },
        valueSetter: (p: ValueSetterParams<GridRow>) => {
          const input = parse(p.newValue);
          if (!input) {
            toast.error(t('timesheet.invalidCell'));
            return false;
          }
          const r = p.data;
          const existing = r.row.entries.find((e) => e.date === day) ?? null;
          const unchanged =
            'clear' in input
              ? !existing
              : existing?.status === input.status && (input.status !== 'WORKED' || Number(existing.hours) === Number(input.hours));
          if (unchanged) return false;
          const shown: TimesheetEntryItem | null =
            'clear' in input
              ? null
              : {
                  id: existing?.id ?? '',
                  date: day,
                  status: input.status,
                  hours: input.hours,
                  note: existing?.note ?? null,
                  version: existing?.version ?? 0,
                  imported: r.row.hasImportedHours,
                  updatedBy: { fullName: myName },
                  updatedAt: new Date().toISOString(),
                };
          setOptimistic((old) => new Map(old).set(`${r.key}|${day}`, shown));
          save({ row: r.row, day, input });
          return false;
        },
        tooltip: (p: TooltipCallbackParams<GridRow>) => {
          const entry = p.data?.cells[day];
          if (p.data?.pending.has(day)) return null;
          const edited = p.data?.row.editedDays.includes(day) ? t('timesheet.editedByHand') : null;
          if (!entry) return edited;
          const what = entry.status === 'WORKED' ? t('timesheet.hoursWorked', { hours: format.number(entry.hours) }) : t(`timesheet.status.${entry.status}`);
          return [what, entry.note, edited, t('timesheet.changedBy', { name: entry.updatedBy.fullName, date: format.date(entry.updatedAt) })]
            .filter(Boolean)
            .join('\n');
        },
        cellClass: (p: CellClassParams<GridRow>) => {
          const r = p.data;
          if (!r) return undefined;
          const entry = r.cells[day];
          return cn(
            'text-center tabular-nums',
            offDay && 'bg-muted',
            !open(r, day) && 'cursor-not-allowed text-muted-foreground',
            r.pending.has(day) && 'opacity-60',
            r.row.editedDays.includes(day) && 'underline decoration-dotted underline-offset-4',
            entry?.status === 'ABSENT' && 'font-semibold text-destructive',
            entry && entry.status !== 'WORKED' && entry.status !== 'ABSENT' && 'font-semibold text-info',
          );
        },
      };
    };

    return [
      {
        colId: 'worker',
        headerName: t('timesheet.worker'),
        pinned: 'left',
        width: 150,
        minWidth: 120,
        suppressMovable: true,
        sortable: false,
        valueGetter: (p: ValueGetterParams<GridRow>) => (p.data ? workerName(p.data.row.worker) : ''),
        tooltip: (p: TooltipCallbackParams<GridRow>) =>
          p.data ? [workerName(p.data.row.worker), p.data.row.worker.position, p.data.row.teamName].filter(Boolean).join('\n') : null,
        cellRenderer: (p: { data?: GridRow }) =>
          p.data ? (
            <div className="flex min-w-0 flex-col justify-center leading-tight">
              <span className="truncate font-medium">{workerName(p.data.row.worker)}</span>
              <span className="truncate text-xs text-muted-foreground">
                {p.data.row.teamName ?? t('timesheet.noTeam')}
                {p.data.row.hasMonthlyTotals && ` · ${t('timesheet.monthlyTotals')}`}
              </span>
            </div>
          ) : null,
      },
      ...days.map(dayColumn),
      {
        colId: 'total',
        headerName: t('timesheet.total'),
        width: 72,
        minWidth: 72,
        sortable: false,
        suppressMovable: true,
        cellClass: 'text-right font-semibold tabular-nums',
        valueGetter: (p: ValueGetterParams<GridRow>) => {
          const sum = Object.values(p.data?.cells ?? {}).reduce(
            (acc, e) => (e?.status === 'WORKED' ? acc + Math.round(Number(e.hours) * 100) : acc),
            0,
          );
          return format.number(sum / 100);
        },
      },
    ];
  }, [codes, days, format, kinds, myName, save, shown, t]);

  return (
    <div className="w-full">
      <AgGridReact<GridRow>
        modules={MODULES}
        theme={GRID_THEME}
        rowData={rows}
        columnDefs={columns}
        getRowId={(p) => p.data.key}
        domLayout="autoHeight"
        stopEditingWhenCellsLoseFocus
        enterNavigatesVerticallyAfterEdit
        tooltipShowDelay={400}
        defaultColDef={{ resizable: false, headerComponent: DayHeader }}
      />
    </div>
  );
}

/** A day column's header: the day of the month over its short weekday. Other headers: their name. */
function DayHeader({ displayName, weekday, offDay }: { displayName: string; weekday?: string; offDay?: string }) {
  if (!weekday) return <span className="truncate">{displayName}</span>;
  return (
    <span className="flex w-full flex-col items-center leading-tight">
      <span className="tabular-nums">{displayName}</span>
      <span className="text-xs font-normal text-muted-foreground">{weekday}</span>
      {offDay && <span className="sr-only">{offDay}</span>}
    </span>
  );
}
