import { zodResolver } from '@hookform/resolvers/zod';
import { FIRM_TYPES, firmSchema, type Firm, type FirmInput, type FirmType } from '@puantaj/schemas';
import { useMutation } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { CalendarCheck, MoreHorizontal, Pencil, Plus, Power, Scale } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable } from '@/components/data-table';
import { Field, fieldControlProps, FormActions, FormError } from '@/components/form';
import { PageHeader } from '@/components/page-header';
import { RequireAccess } from '@/components/require-access';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { canManageCompany, canViewPayRules, seesFirms, usesFirms, useMe, type Me } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { today } from '@/lib/format';
import { stillPlaced, useFirms, useRefreshOrganisation, useWorkers, type FirmItem } from '@/lib/organisation';

/**
 * The company's firms (AGENTS.md: Firms): its own legal entities and subcontractors. Owners and
 * admins manage them; accountants and project managers only look. Switching them on is in
 * Company settings.
 */
export function FirmsPage() {
  const { t } = useTranslation();
  const me = useMe().data;
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title={t('firms.title')}
        description={t('firms.description')}
        actions={
          canManageCompany(me) && (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              {t('firms.create')}
            </Button>
          )
        }
      />
      <RequireAccess allowed={seesFirms}>
        {(verified) => <FirmsView me={verified} creating={creating} onCreatingChange={setCreating} />}
      </RequireAccess>
    </>
  );
}

const ALL_TYPES = 'all';

function FirmsView({ me, creating, onCreatingChange }: { me: Me; creating: boolean; onCreatingChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const firms = useFirms();
  const workers = useWorkers();
  const refresh = useRefreshOrganisation();
  const [editing, setEditing] = useState<FirmItem | null>(null);
  const [toggling, setToggling] = useState<FirmItem | null>(null);
  const [typeFilter, setTypeFilter] = useState<FirmType | typeof ALL_TYPES>(ALL_TYPES);
  const manages = canManageCompany(me);
  const seesRules = canViewPayRules(me);
  const enabled = usesFirms(me);

  // Counted from the list the page has: workers placed in the firm today. Project managers see only their sites' workers.
  const working = useMemo(() => stillPlaced(workers.data ?? [], today()), [workers.data]);
  const missing = working.filter((w) => !w.placement.firmId).length;
  const rows = useMemo(
    () => firms.data?.filter((f) => typeFilter === ALL_TYPES || f.type === typeFilter),
    [firms.data, typeFilter],
  );

  const columns = useMemo<ColumnDef<FirmItem, unknown>[]>(
    () => [
      {
        id: 'name',
        accessorKey: 'name',
        header: t('firms.name'),
        cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      },
      {
        id: 'type',
        header: t('firms.type'),
        enableSorting: false,
        cell: ({ row }) => <StatusBadge tone="info">{t(`firms.types.${row.original.type}`)}</StatusBadge>,
      },
      {
        id: 'workers',
        header: t('firms.workers'),
        enableSorting: false,
        cell: ({ row }) => (
          <span className="tabular-nums">{working.filter((w) => w.placement.firmId === row.original.id).length}</span>
        ),
      },
      {
        id: 'status',
        header: t('firms.status'),
        enableSorting: false,
        cell: ({ row }) =>
          row.original.isActive ? (
            <StatusBadge tone="success">{t('firms.active')}</StatusBadge>
          ) : (
            <StatusBadge tone="neutral">{t('firms.closed')}</StatusBadge>
          ),
      },
      ...(manages || seesRules
        ? [
            {
              id: 'actions',
              header: () => <span className="sr-only">{t('common.actions')}</span>,
              enableSorting: false,
              cell: ({ row }) => (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label={t('common.actionsFor', { name: row.original.name })}>
                      <MoreHorizontal aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {manages && (
                      <DropdownMenuItem onSelect={() => setEditing(row.original)}>
                        <Pencil aria-hidden />
                        {t('firms.edit')}
                      </DropdownMenuItem>
                    )}
                    {seesRules && (
                      <>
                        <DropdownMenuItem asChild>
                          <Link to={`/firms/${row.original.id}/pay-rules`}>
                            <Scale aria-hidden />
                            {t('firms.payRules')}
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                          <Link to={`/firms/${row.original.id}/working-days`}>
                            <CalendarCheck aria-hidden />
                            {t('firms.workingDays')}
                          </Link>
                        </DropdownMenuItem>
                      </>
                    )}
                    {manages && (
                      <DropdownMenuItem onSelect={() => setToggling(row.original)}>
                        <Power aria-hidden />
                        {row.original.isActive ? t('firms.close') : t('firms.reopen')}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              ),
            } satisfies ColumnDef<FirmItem, unknown>,
          ]
        : []),
    ],
    [t, working, manages, seesRules],
  );

  const closeDialog = () => {
    onCreatingChange(false);
    setEditing(null);
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-sm">
        <p className="flex flex-wrap items-center gap-2">
          {enabled ? <StatusBadge tone="success">{t('firms.on')}</StatusBadge> : <StatusBadge tone="neutral">{t('firms.off')}</StatusBadge>}
          <span className="text-muted-foreground">{enabled ? t('firms.onHint') : t('firms.offHint')}</span>
          {manages && (
            <Link to="/settings/company" className="underline underline-offset-4">
              {t('firms.settingLink')}
            </Link>
          )}
        </p>
        {enabled && missing > 0 && (
          <p className="flex flex-wrap items-center gap-2">
            <StatusBadge tone="warning">{t('firms.missing', { count: missing })}</StatusBadge>
            <Link to="/workers" className="underline underline-offset-4">
              {t('firms.missingLink')}
            </Link>
          </p>
        )}
      </div>
      <DataTable
        columns={columns}
        data={rows}
        isLoading={firms.isPending}
        isError={firms.isError}
        onRetry={() => firms.refetch()}
        totalCount={firms.data?.length}
        searchable
        searchText={(f) => f.name}
        toolbar={
          <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as typeof typeFilter)}>
            <SelectTrigger className="w-full sm:w-56" aria-label={t('firms.type')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_TYPES}>{t('firms.all')}</SelectItem>
              {FIRM_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {t(`firms.allOfType.${type}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
        emptyTitle={t('firms.empty')}
        emptyDescription={t('firms.emptyDescription')}
      />
      {(creating || editing) && (
        <FirmDialog
          key={editing?.id ?? 'new'}
          current={editing}
          onClose={closeDialog}
          onSaved={async () => {
            closeDialog();
            toast.success(t('common.saved'));
            await refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={toggling !== null}
        onOpenChange={(open) => !open && setToggling(null)}
        title={toggling?.isActive ? t('firms.confirmClose.title') : t('firms.confirmReopen.title')}
        description={
          toggling
            ? toggling.isActive
              ? t('firms.confirmClose.description', { name: toggling.name })
              : t('firms.confirmReopen.description', { name: toggling.name })
            : ''
        }
        confirmLabel={toggling?.isActive ? t('firms.close') : t('firms.reopen')}
        destructive={toggling?.isActive}
        onConfirm={async () => {
          if (!toggling) return;
          await api.patch(`/firms/${toggling.id}`, { isActive: !toggling.isActive });
          toast.success(t('common.saved'));
          await refresh();
        }}
      />
    </div>
  );
}

/** Adds a firm, or renames one or changes its type. */
function FirmDialog({ current, onClose, onSaved }: { current: FirmItem | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [formError, setFormError] = useState<string>();
  const form = useForm<FirmInput, unknown, Firm>({
    resolver: zodResolver(firmSchema),
    defaultValues: current ? { name: current.name, type: current.type } : { name: '', type: undefined },
  });
  const { errors } = form.formState;

  const save = useMutation({
    mutationFn: (values: Firm) => (current ? api.patch(`/firms/${current.id}`, values) : api.post('/firms', values)),
    onSuccess: onSaved,
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{current ? t('firms.edit') : t('firms.create')}</DialogTitle>
          <DialogDescription>{t('firms.dialogDescription')}</DialogDescription>
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
          <Field id="f-name" label={t('firms.name')} error={errors.name}>
            <Input {...fieldControlProps('f-name', errors.name)} {...form.register('name')} autoComplete="off" />
          </Field>
          <Controller
            control={form.control}
            name="type"
            render={({ field }) => (
              <Field id="f-type" label={t('firms.type')} error={errors.type} hint={t('firms.typeHint')}>
                <Select value={field.value ?? ''} onValueChange={field.onChange}>
                  <SelectTrigger id="f-type" className="w-full" aria-invalid={errors.type ? true : undefined}>
                    <SelectValue placeholder={t('firms.chooseType')} />
                  </SelectTrigger>
                  <SelectContent>
                    {FIRM_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {t(`firms.types.${type}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          />
          <FormActions submitLabel={current ? t('common.save') : t('firms.create')} pending={save.isPending} onCancel={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
