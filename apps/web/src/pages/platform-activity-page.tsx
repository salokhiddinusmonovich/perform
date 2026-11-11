import { AUDIT_AREAS, AUDIT_PAGE_SIZE, type AuditArea, type AuditQueryInput } from '@puantaj/schemas';
import type { ColumnDef } from '@tanstack/react-table';
import { Eye, History, X } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { DataTable } from '@/components/data-table';
import { DatePicker } from '@/components/date-picker';
import { PageHeader } from '@/components/page-header';
import { RequireAccess } from '@/components/require-access';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useFormat } from '@/hooks/use-format';
import { isPlatformAdmin } from '@/lib/auth';
import { useAuditLog, useCompanies, usePlatformUsers, type AuditEntryRow } from '@/lib/platform';

/** "Every company", "everyone", "every area": can't be mistaken for an id or an area. */
const ALL = 'all';

/** Search params of the page, so a company's or person's "History" can link here. */
const PARAM = { company: 'company', user: 'user', area: 'area', from: 'from', to: 'to', logins: 'logins' } as const;

/** The start of a calendar day "YYYY-MM-DD" in the viewer's time zone, as an ISO timestamp. */
function startOfDay(day: string, addDays = 0) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d + addDays).toISOString();
}

const isArea = (value: string | null): value is AuditArea => (AUDIT_AREAS as readonly string[]).includes(value ?? '');

export function PlatformActivityPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('audit.title')} description={t('audit.description')} />
      <RequireAccess allowed={isPlatformAdmin}>{() => <ActivityView />}</RequireAccess>
    </>
  );
}

/** The name of an action, e.g. "Site created"; an older code the app no longer records is named as such. */
function useActionLabel() {
  const { t, i18n } = useTranslation();
  return useCallback(
    (action: string) =>
      i18n.exists(`audit.actions.${action}`) ? t(`audit.actions.${action}`) : t('audit.unknownAction', { code: action }),
    [t, i18n],
  );
}

function ActivityView() {
  const { t } = useTranslation();
  const format = useFormat();
  const actionLabel = useActionLabel();
  const [params, setParams] = useSearchParams();
  const companies = useCompanies();
  const users = usePlatformUsers();
  const [open, setOpen] = useState<AuditEntryRow | null>(null);

  const companyId = params.get(PARAM.company) ?? '';
  const userId = params.get(PARAM.user) ?? '';
  const area = params.get(PARAM.area);
  const from = params.get(PARAM.from) ?? '';
  const to = params.get(PARAM.to) ?? '';
  const logins = params.get(PARAM.logins) === 'true';
  const filtered = Boolean(companyId || userId || area || from || to || logins);

  const setParam = (key: string, value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value && value !== ALL) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );

  const query: Omit<AuditQueryInput, 'before'> = {
    companyId: companyId || undefined,
    userId: userId || undefined,
    area: isArea(area) ? area : undefined,
    logins: logins ? 'true' : undefined,
    from: from ? startOfDay(from) : undefined,
    // The "to" day is included: entries before the start of the next day.
    to: to ? startOfDay(to, 1) : undefined,
  };
  const log = useAuditLog(query);
  const entries = useMemo(() => log.data?.pages.flatMap((p) => p.entries), [log.data]);

  const columns = useMemo<ColumnDef<AuditEntryRow, unknown>[]>(
    () => [
      {
        accessorKey: 'createdAt',
        header: t('audit.when'),
        cell: ({ row }) => (
          <div className="whitespace-nowrap">
            <div>{format.date(row.original.createdAt)}</div>
            <div className="text-sm text-muted-foreground">{format.time(row.original.createdAt)}</div>
          </div>
        ),
      },
      {
        id: 'action',
        header: t('audit.action'),
        enableSorting: false,
        cell: ({ row }) => <div className="min-w-40 font-medium">{actionLabel(row.original.action)}</div>,
      },
      {
        id: 'who',
        header: t('audit.who'),
        enableSorting: false,
        cell: ({ row }) => <Who entry={row.original} />,
      },
      {
        id: 'company',
        header: t('platform.company'),
        enableSorting: false,
        cell: ({ row }) =>
          row.original.company?.name ?? <span className="text-muted-foreground">{t('audit.noCompany')}</span>,
      },
      {
        id: 'details',
        header: () => <span className="sr-only">{t('audit.details')}</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('audit.detailsFor', { action: actionLabel(row.original.action) })}
            onClick={() => setOpen(row.original)}
          >
            <Eye aria-hidden />
          </Button>
        ),
      },
    ],
    [t, format, actionLabel],
  );

  return (
    <>
      <DataTable
        columns={columns}
        data={entries}
        isLoading={log.isPending}
        isError={log.isError}
        onRetry={() => log.refetch()}
        searchable
        searchText={(e) =>
          [actionLabel(e.action), e.actor?.fullName, e.impersonator?.fullName, e.company?.name].filter(Boolean).join(' ')
        }
        pageSize={AUDIT_PAGE_SIZE / 4}
        emptyTitle={filtered ? t('states.noResults') : t('audit.empty')}
        toolbar={
          <div className="flex w-full flex-wrap items-end gap-2">
            <Select value={companyId || ALL} onValueChange={(v) => setParam(PARAM.company, v)}>
              <SelectTrigger className="w-full sm:w-48" aria-label={t('platform.company')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t('audit.allCompanies')}</SelectItem>
                {companies.data?.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={userId || ALL} onValueChange={(v) => setParam(PARAM.user, v)}>
              <SelectTrigger className="w-full sm:w-48" aria-label={t('audit.person')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t('audit.everyone')}</SelectItem>
                {users.data?.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.fullName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={isArea(area) ? area : ALL} onValueChange={(v) => setParam(PARAM.area, v)}>
              <SelectTrigger className="w-full sm:w-48" aria-label={t('audit.area')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t('audit.allAreas')}</SelectItem>
                {AUDIT_AREAS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {t(`audit.areas.${a}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="w-full space-y-1 sm:w-44">
              <Label htmlFor="audit-from">{t('audit.from')}</Label>
              <DatePicker id="audit-from" value={from} onChange={(v) => setParam(PARAM.from, v)} />
            </div>
            <div className="w-full space-y-1 sm:w-44">
              <Label htmlFor="audit-to">{t('audit.to')}</Label>
              <DatePicker id="audit-to" value={to} onChange={(v) => setParam(PARAM.to, v)} defaultMonth={from || undefined} />
            </div>
            <div className="flex h-10 items-center gap-2">
              <Checkbox
                id="audit-logins"
                checked={logins}
                onCheckedChange={(v) => setParam(PARAM.logins, v === true ? 'true' : '')}
              />
              <Label htmlFor="audit-logins">{t('audit.showLogins')}</Label>
            </div>
            {filtered && (
              <Button variant="ghost" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                <X aria-hidden />
                {t('audit.clearFilters')}
              </Button>
            )}
          </div>
        }
      />
      {log.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" onClick={() => log.fetchNextPage()} disabled={log.isFetchingNextPage}>
            <History aria-hidden />
            {t('audit.loadOlder')}
          </Button>
        </div>
      )}
      <EntryDialog entry={open} onClose={() => setOpen(null)} />
    </>
  );
}

/** Who did it; "Admin as Owner" when a platform admin was logged in as someone. */
function Who({ entry }: { entry: AuditEntryRow }) {
  const { t } = useTranslation();
  if (!entry.actor) return <span className="text-muted-foreground">{t('audit.system')}</span>;
  if (!entry.impersonator) return <span>{entry.actor.fullName}</span>;
  return (
    <div className="min-w-40 space-y-1">
      <div>{t('audit.asUser', { admin: entry.impersonator.fullName, user: entry.actor.fullName })}</div>
      <StatusBadge tone="warning">{t('audit.impersonated')}</StatusBadge>
    </div>
  );
}

type Change = { from: unknown; to: unknown };
const isChange = (v: unknown): v is Change =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).sort().join() === 'from,to';

/** A stored value as text: plain for text and numbers, JSON for the rest. */
function ValueText({ value }: { value: unknown }) {
  const { t } = useTranslation();
  if (value === null || value === undefined || value === '') {
    return <span className="text-muted-foreground">{t('audit.blank')}</span>;
  }
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : JSON.stringify(value, null, 2);
  return <span className="whitespace-pre-wrap break-all font-mono text-sm">{text}</span>;
}

function EntryDialog({ entry, onClose }: { entry: AuditEntryRow | null; onClose: () => void }) {
  const { t } = useTranslation();
  const format = useFormat();
  const actionLabel = useActionLabel();
  const data = entry && typeof entry.data === 'object' && entry.data !== null && !Array.isArray(entry.data)
    ? Object.entries(entry.data as Record<string, unknown>)
    : [];
  const changes = data.length > 0 && data.every(([, v]) => isChange(v));

  return (
    <Dialog open={entry !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        {entry && (
          <>
            <DialogHeader>
              <DialogTitle>{actionLabel(entry.action)}</DialogTitle>
              <DialogDescription>
                {format.date(entry.createdAt)} {format.time(entry.createdAt)}
              </DialogDescription>
            </DialogHeader>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
              <dt className="text-muted-foreground">{t('audit.who')}</dt>
              <dd className="sm:col-span-2">
                <Who entry={entry} />
              </dd>
              <dt className="text-muted-foreground">{t('platform.company')}</dt>
              <dd className="sm:col-span-2">{entry.company?.name ?? t('audit.noCompany')}</dd>
              {entry.entityType && (
                <>
                  <dt className="text-muted-foreground">{t('audit.record')}</dt>
                  <dd className="break-all font-mono sm:col-span-2">
                    {entry.entityType} {entry.entityId}
                  </dd>
                </>
              )}
              {entry.ip && (
                <>
                  <dt className="text-muted-foreground">{t('audit.ip')}</dt>
                  <dd className="font-mono sm:col-span-2">{entry.ip}</dd>
                </>
              )}
              <dt className="text-muted-foreground">{t('audit.code')}</dt>
              <dd className="font-mono sm:col-span-2">{entry.action}</dd>
            </dl>
            {data.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('audit.noDetails')}</p>
            ) : (
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('audit.field')}</TableHead>
                      {changes ? (
                        <>
                          <TableHead>{t('audit.before')}</TableHead>
                          <TableHead>{t('audit.after')}</TableHead>
                        </>
                      ) : (
                        <TableHead>{t('audit.value')}</TableHead>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.map(([field, value]) => (
                      <TableRow key={field}>
                        <TableCell className="align-top font-mono text-sm">{field}</TableCell>
                        {changes && isChange(value) ? (
                          <>
                            <TableCell className="align-top">
                              <ValueText value={value.from} />
                            </TableCell>
                            <TableCell className="align-top">
                              <ValueText value={value.to} />
                            </TableCell>
                          </>
                        ) : (
                          <TableCell className="align-top">
                            <ValueText value={value} />
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
