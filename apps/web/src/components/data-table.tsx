import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type FilterFn,
  type SortingState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { SearchInput } from '@/components/search-input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { matchesSearch } from '@/lib/utils';

interface DataTableProps<TData> {
  columns: ColumnDef<TData, unknown>[];
  data: TData[] | undefined;
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  /** Shows the search box; filters across all columns. */
  searchable?: boolean;
  /**
   * Text the search box matches against for each row, when it should cover more than
   * the visible column values (e.g. a person's phone and email under their name).
   */
  searchText?: (row: TData) => string;
  /** Filters and actions shown next to the search box. */
  toolbar?: ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  pageSize?: number;
  /**
   * The rows before the page's own filters, when `data` is already filtered: the table then
   * says "no results" instead of "nothing here yet", and "3 of 10 rows".
   */
  totalCount?: number;
}

const SKELETON_ROWS = 5;

/** The one table used by every list page (AGENTS.md). */
export function DataTable<TData>({
  columns,
  data,
  isLoading = false,
  isError = false,
  onRetry,
  searchable = false,
  searchText,
  toolbar,
  emptyTitle,
  emptyDescription,
  emptyAction,
  pageSize = 25,
  totalCount,
}: DataTableProps<TData>) {
  const { t } = useTranslation();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState('');

  const searchFilter: FilterFn<TData> | undefined = searchText
    ? (row, _columnId, filter: string) =>
        matchesSearch(searchText(row.original), filter)
    : undefined;

  const table = useReactTable<TData>({
    data: data ?? [],
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    ...(searchFilter && { globalFilterFn: searchFilter }),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });

  const rows = table.getRowModel().rows;
  const filteredCount = table.getFilteredRowModel().rows.length;
  const pageCount = table.getPageCount();
  const total = totalCount ?? data?.length ?? 0;
  const hasData = total > 0;

  let body: ReactNode;
  if (isError) {
    body = <ErrorState onRetry={onRetry} />;
  } else if (!isLoading && !hasData) {
    body = (
      <EmptyState
        title={emptyTitle ?? t('states.emptyTitle')}
        description={emptyDescription}
        action={emptyAction}
      />
    );
  } else if (!isLoading && filteredCount === 0) {
    body = <EmptyState icon={Search} title={t('states.noResults')} />;
  }

  return (
    <div className="space-y-3">
      {(searchable || toolbar) && (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          {searchable && <SearchInput value={globalFilter} onChange={setGlobalFilter} />}
          {toolbar && <div className="flex flex-wrap items-center gap-2 sm:ml-auto">{toolbar}</div>}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border bg-card">
        {body ?? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((group) => (
                  <TableRow key={group.id}>
                    {group.headers.map((header) => {
                      const sorted = header.column.getIsSorted();
                      const SortIcon = sorted === 'asc' ? ArrowUp : sorted === 'desc' ? ArrowDown : ArrowUpDown;
                      return (
                        <TableHead
                          key={header.id}
                          aria-sort={
                            sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined
                          }
                        >
                          {header.isPlaceholder ? null : header.column.getCanSort() ? (
                            <button
                              type="button"
                              onClick={header.column.getToggleSortingHandler()}
                              className="-mx-2 inline-flex min-h-10 items-center gap-1 rounded-md px-2 hover:bg-accent"
                            >
                              {flexRender(header.column.columnDef.header, header.getContext())}
                              <SortIcon
                                className={sorted ? 'size-3.5' : 'size-3.5 text-muted-foreground'}
                                aria-hidden
                              />
                            </button>
                          ) : (
                            flexRender(header.column.columnDef.header, header.getContext())
                          )}
                        </TableHead>
                      );
                    })}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {isLoading
                  ? Array.from({ length: SKELETON_ROWS }, (_, i) => (
                      <TableRow key={i} aria-hidden>
                        {columns.map((_, j) => (
                          <TableCell key={j}>
                            <Skeleton className="h-5 w-full" />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  : rows.map((row) => (
                      <TableRow key={row.id}>
                        {row.getVisibleCells().map((cell) => (
                          <TableCell key={cell.id}>
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {!isLoading && !isError && filteredCount > 0 && (
        <div className="flex flex-col gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>
            {filteredCount < total
              ? t('common.rowsOfTotal', { shown: filteredCount, total })
              : t('common.rowsTotal', { count: filteredCount })}
          </span>
          {pageCount > 1 && (
            <div className="flex items-center gap-2">
              <span>
                {t('common.page', { page: table.getState().pagination.pageIndex + 1, total: pageCount })}
              </span>
              <Button
                variant="outline"
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
              >
                {t('common.previous')}
              </Button>
              <Button variant="outline" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
                {t('common.next')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
