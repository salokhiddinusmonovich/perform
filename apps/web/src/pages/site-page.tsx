import { zodResolver } from '@hookform/resolvers/zod';
import { teamSchema, type Team, type TeamInput } from '@puantaj/schemas';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowLeft, MoreHorizontal, Pencil, Plus, Power, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { AssignPeopleDialog, type Person } from '@/components/assign-people-dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { Field, fieldControlProps, FormActions, FormError } from '@/components/form';
import { LoadingState } from '@/components/loading-state';
import { PageHeader } from '@/components/page-header';
import { RequireAccess } from '@/components/require-access';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { canManageCompany, inCompany, type Me } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { useRefreshOrganisation, useSites, type SiteItem, type TeamItem } from '@/lib/organisation';

export function SitePage() {
  return <RequireAccess allowed={inCompany}>{(me) => <SiteView me={me} />}</RequireAccess>;
}

function SiteView({ me }: { me: Me }) {
  const { t } = useTranslation();
  const { siteId } = useParams();
  const sites = useSites();
  const site = sites.data?.find((s) => s.id === siteId);

  if (sites.isPending) return <LoadingState />;
  if (sites.isError) return <ErrorState onRetry={() => sites.refetch()} />;
  if (!site) {
    return (
      <EmptyState
        title={t('notFound.title')}
        description={t('sites.notFoundDescription')}
        action={
          <Button asChild variant="outline">
            <Link to="/sites">{t('sites.backToSites')}</Link>
          </Button>
        }
      />
    );
  }
  return <SiteDetails me={me} site={site} />;
}

function SiteDetails({ me, site }: { me: Me; site: SiteItem }) {
  const { t } = useTranslation();
  const refresh = useRefreshOrganisation();
  // A project manager manages teams and timekeepers only on their own sites; the API checks too.
  const managesSite = canManageCompany(me) || (me.activeCompany?.role === 'PROJECT_MANAGER' && Boolean(me.activeCompany.siteIds?.includes(site.id)));
  const candidates = useQuery({
    queryKey: ['sites', 'staff-candidates'],
    queryFn: () => api.get<Person[]>('/sites/staff-candidates'),
    enabled: managesSite,
  });
  const [staffOpen, setStaffOpen] = useState(false);
  const [addingTeam, setAddingTeam] = useState(false);
  const [editingTeam, setEditingTeam] = useState<TeamItem | null>(null);
  const [foremenOf, setForemenOf] = useState<TeamItem | null>(null);
  const [toggling, setToggling] = useState<TeamItem | null>(null);

  const columns = useMemo<ColumnDef<TeamItem, unknown>[]>(
    () => [
      {
        accessorKey: 'name',
        header: t('teams.name'),
        cell: ({ row }) => (
          <div className="min-w-32">
            <div className="font-medium">{row.original.name}</div>
            {row.original.department && <div className="text-sm text-muted-foreground">{row.original.department}</div>}
          </div>
        ),
      },
      {
        id: 'foremen',
        header: t('teams.foremen'),
        enableSorting: false,
        cell: ({ row }) => (row.original.foremen.length ? row.original.foremen.map((f) => f.fullName).join(', ') : '—'),
      },
      { accessorKey: 'workerCount', header: t('sites.workers') },
      {
        accessorKey: 'isActive',
        header: t('sites.status'),
        cell: ({ row }) =>
          row.original.isActive ? (
            <StatusBadge tone="success">{t('sites.active')}</StatusBadge>
          ) : (
            <StatusBadge tone="neutral">{t('teams.closed')}</StatusBadge>
          ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{t('common.actions')}</span>,
        enableSorting: false,
        cell: ({ row }) =>
          managesSite && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={t('common.actionsFor', { name: row.original.name })}>
                  <MoreHorizontal aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setForemenOf(row.original)}>
                  <Users aria-hidden />
                  {t('teams.manageForemen')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setEditingTeam(row.original)}>
                  <Pencil aria-hidden />
                  {t('teams.edit')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setToggling(row.original)}>
                  <Power aria-hidden />
                  {row.original.isActive ? t('teams.close') : t('teams.reopen')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ),
      },
    ],
    [t, managesSite],
  );

  // Who may be removed: owners and admins anyone; a project manager only timekeepers.
  const canRemoveStaff = (p: Person) => canManageCompany(me) || p.role === 'TIMEKEEPER';
  const team = foremenOf && site.teams.find((x) => x.id === foremenOf.id);

  return (
    <>
      <PageHeader
        title={site.name}
        description={[site.code, site.address].filter(Boolean).join(' · ') || undefined}
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/sites">
                <ArrowLeft aria-hidden />
                {t('sites.backToSites')}
              </Link>
            </Button>
            {managesSite && site.isActive && (
              <Button onClick={() => setAddingTeam(true)}>
                <Plus aria-hidden />
                {t('teams.add')}
              </Button>
            )}
          </>
        }
      />
      {!site.isActive && (
        <p className="mb-4">
          <StatusBadge tone="neutral">{t('sites.closed')}</StatusBadge>
        </p>
      )}
      <div className="space-y-6">
        <Card>
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1.5">
              <CardTitle>{t('sites.staff')}</CardTitle>
              <CardDescription>{t('sites.staffHint')}</CardDescription>
            </div>
            {managesSite && (
              <Button variant="outline" onClick={() => setStaffOpen(true)}>
                <Users aria-hidden />
                {t('sites.manageStaff')}
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {site.staff.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('sites.nobodyAssigned')}</p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {site.staff.map((p) => (
                  <li key={p.userId}>
                    <span className="font-medium">{p.fullName}</span>
                    <span className="text-muted-foreground"> · {t(`roles.${p.role}`)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{t('sites.teams')}</h2>
          <DataTable
            columns={columns}
            data={site.teams}
            emptyTitle={t('teams.emptyTitle')}
            emptyDescription={managesSite ? t('teams.emptyDescription') : undefined}
          />
        </section>
      </div>

      <AssignPeopleDialog
        open={staffOpen}
        onClose={() => setStaffOpen(false)}
        title={t('sites.manageStaff')}
        description={t('sites.staffDialogHint', { site: site.name })}
        assigned={site.staff}
        candidates={(candidates.data ?? []).filter((c) => c.role !== 'FOREMAN')}
        canRemove={canRemoveStaff}
        onAdd={async (userId) => {
          await api.post(`/sites/${site.id}/staff`, { userId });
          await refresh();
        }}
        onRemove={async (userId) => {
          await api.delete(`/sites/${site.id}/staff/${userId}`);
          await refresh();
        }}
      />
      <AssignPeopleDialog
        open={team !== null && team !== undefined}
        onClose={() => setForemenOf(null)}
        title={t('teams.manageForemen')}
        description={team ? t('teams.foremenDialogHint', { team: team.name }) : ''}
        assigned={team?.foremen ?? []}
        candidates={(candidates.data ?? []).filter((c) => c.role === 'FOREMAN')}
        canRemove={() => true}
        onAdd={async (userId) => {
          await api.post(`/teams/${foremenOf!.id}/foremen`, { userId });
          await refresh();
        }}
        onRemove={async (userId) => {
          await api.delete(`/teams/${foremenOf!.id}/foremen/${userId}`);
          await refresh();
        }}
      />
      <TeamDialog
        key={editingTeam?.id ?? 'new'}
        open={addingTeam || editingTeam !== null}
        siteId={site.id}
        team={editingTeam}
        onClose={() => {
          setAddingTeam(false);
          setEditingTeam(null);
        }}
        onSaved={async () => {
          setAddingTeam(false);
          setEditingTeam(null);
          toast.success(t('common.saved'));
          await refresh();
        }}
      />
      <ConfirmDialog
        open={toggling !== null}
        onOpenChange={(open) => !open && setToggling(null)}
        title={toggling?.isActive ? t('teams.confirmClose.title') : t('teams.confirmReopen.title')}
        description={
          toggling
            ? toggling.isActive
              ? t('teams.confirmClose.description', { name: toggling.name })
              : t('teams.confirmReopen.description', { name: toggling.name })
            : ''
        }
        confirmLabel={toggling?.isActive ? t('teams.close') : t('teams.reopen')}
        destructive={toggling?.isActive}
        onConfirm={async () => {
          if (!toggling) return;
          await api.patch(`/teams/${toggling.id}`, { isActive: !toggling.isActive });
          toast.success(t('common.saved'));
          await refresh();
        }}
      />
    </>
  );
}

function TeamDialog({
  open,
  siteId,
  team,
  onClose,
  onSaved,
}: {
  open: boolean;
  siteId: string;
  /** null = adding */
  team: TeamItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [formError, setFormError] = useState<string>();
  const form = useForm<TeamInput, unknown, Team>({
    resolver: zodResolver(teamSchema),
    defaultValues: { siteId, name: team?.name ?? '', department: team?.department ?? '' },
  });
  const { errors } = form.formState;

  const save = useMutation({
    mutationFn: ({ siteId: _site, ...changes }: Team) =>
      team ? api.patch(`/teams/${team.id}`, changes) : api.post('/teams', { siteId, ...changes }),
    onSuccess: onSaved,
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{team ? t('teams.edit') : t('teams.add')}</DialogTitle>
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
          <Field id="t-name" label={t('teams.name')} error={errors.name}>
            <Input {...fieldControlProps('t-name', errors.name)} {...form.register('name')} autoComplete="off" />
          </Field>
          <Field id="t-department" label={t('teams.department')} error={errors.department} hint={t('teams.departmentHint')}>
            <Input {...fieldControlProps('t-department', errors.department)} {...form.register('department')} autoComplete="off" />
          </Field>
          <FormActions submitLabel={t('common.save')} pending={save.isPending} onCancel={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
