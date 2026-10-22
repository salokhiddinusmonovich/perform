import { zodResolver } from '@hookform/resolvers/zod';
import { siteSchema, type Site, type SiteInput } from '@puantaj/schemas';
import { useMutation } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Building2, MoreHorizontal, Pencil, Plus, Power } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { canManageCompany, inCompany, useMe, type Me } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { useRefreshOrganisation, useSites, type SiteItem } from '@/lib/organisation';

export function SitesPage() {
  const { t } = useTranslation();
  const me = useMe().data;
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHeader
        title={t('sites.title')}
        description={t('sites.description')}
        actions={
          canManageCompany(me) && (
            <Button onClick={() => setAdding(true)}>
              <Plus aria-hidden />
              {t('sites.add')}
            </Button>
          )
        }
      />
      <RequireAccess allowed={inCompany}>
        {(verified) => <SitesView me={verified} adding={adding} onAddingChange={setAdding} />}
      </RequireAccess>
    </>
  );
}

function SitesView({ me, adding, onAddingChange }: { me: Me; adding: boolean; onAddingChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const sites = useSites();
  const refresh = useRefreshOrganisation();
  const manage = canManageCompany(me);
  const [editing, setEditing] = useState<SiteItem | null>(null);
  const [toggling, setToggling] = useState<SiteItem | null>(null);

  const columns = useMemo<ColumnDef<SiteItem, unknown>[]>(
    () => [
      {
        accessorKey: 'name',
        header: t('sites.name'),
        cell: ({ row }) => (
          <div className="min-w-40">
            <Link to={`/sites/${row.original.id}`} className="font-medium underline-offset-4 hover:underline">
              {row.original.name}
            </Link>
            {row.original.code && <div className="text-sm text-muted-foreground">{row.original.code}</div>}
          </div>
        ),
      },
      {
        accessorKey: 'address',
        header: t('sites.address'),
        enableSorting: false,
        cell: ({ row }) => row.original.address ?? '—',
      },
      {
        id: 'teams',
        header: t('sites.teams'),
        accessorFn: (s) => s.teams.length,
      },
      {
        accessorKey: 'workerCount',
        header: t('sites.workers'),
      },
      {
        accessorKey: 'isActive',
        header: t('sites.status'),
        cell: ({ row }) =>
          row.original.isActive ? (
            <StatusBadge tone="success">{t('sites.active')}</StatusBadge>
          ) : (
            <StatusBadge tone="neutral">{t('sites.closed')}</StatusBadge>
          ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{t('common.actions')}</span>,
        enableSorting: false,
        cell: ({ row }) =>
          manage && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={t('common.actionsFor', { name: row.original.name })}>
                  <MoreHorizontal aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setEditing(row.original)}>
                  <Pencil aria-hidden />
                  {t('sites.edit')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setToggling(row.original)}>
                  <Power aria-hidden />
                  {row.original.isActive ? t('sites.close') : t('sites.reopen')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ),
      },
    ],
    [t, manage],
  );

  return (
    <>
      <DataTable
        columns={columns}
        data={sites.data}
        isLoading={sites.isPending}
        isError={sites.isError}
        onRetry={() => sites.refetch()}
        searchable
        searchText={(s) => [s.name, s.code, s.address].filter(Boolean).join(' ')}
        emptyTitle={t('sites.emptyTitle')}
        emptyDescription={manage ? t('sites.emptyDescription') : t('sites.emptyDescriptionNotAssigned')}
      />
      <SiteDialog
        key={editing?.id ?? 'new'}
        open={adding || editing !== null}
        site={editing}
        onClose={() => {
          onAddingChange(false);
          setEditing(null);
        }}
        onSaved={async () => {
          onAddingChange(false);
          setEditing(null);
          toast.success(t('common.saved'));
          await refresh();
        }}
      />
      <ConfirmDialog
        open={toggling !== null}
        onOpenChange={(open) => !open && setToggling(null)}
        title={toggling?.isActive ? t('sites.confirmClose.title') : t('sites.confirmReopen.title')}
        description={
          toggling
            ? toggling.isActive
              ? t('sites.confirmClose.description', { name: toggling.name })
              : t('sites.confirmReopen.description', { name: toggling.name })
            : ''
        }
        confirmLabel={toggling?.isActive ? t('sites.close') : t('sites.reopen')}
        destructive={toggling?.isActive}
        onConfirm={async () => {
          if (!toggling) return;
          await api.patch(`/sites/${toggling.id}`, { isActive: !toggling.isActive });
          toast.success(t('common.saved'));
          await refresh();
        }}
      />
    </>
  );
}

function SiteDialog({
  open,
  site,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** null = adding */
  site: SiteItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [formError, setFormError] = useState<string>();
  const form = useForm<SiteInput, unknown, Site>({
    resolver: zodResolver(siteSchema),
    defaultValues: { name: site?.name ?? '', code: site?.code ?? '', address: site?.address ?? '' },
  });
  const { errors } = form.formState;

  const save = useMutation({
    mutationFn: (values: Site) => (site ? api.patch(`/sites/${site.id}`, values) : api.post('/sites', values)),
    onSuccess: onSaved,
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 aria-hidden className="size-5" />
            {site ? t('sites.edit') : t('sites.add')}
          </DialogTitle>
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
          <Field id="s-name" label={t('sites.name')} error={errors.name}>
            <Input {...fieldControlProps('s-name', errors.name)} {...form.register('name')} autoComplete="off" />
          </Field>
          <Field id="s-code" label={t('sites.code')} error={errors.code} hint={t('sites.codeHint')}>
            <Input {...fieldControlProps('s-code', errors.code)} {...form.register('code')} autoComplete="off" />
          </Field>
          <Field id="s-address" label={t('sites.address')} error={errors.address}>
            <Input {...fieldControlProps('s-address', errors.address)} {...form.register('address')} autoComplete="off" />
          </Field>
          <FormActions submitLabel={t('common.save')} pending={save.isPending} onCancel={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
