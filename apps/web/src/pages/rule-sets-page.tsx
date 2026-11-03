import { zodResolver } from '@hookform/resolvers/zod';
import { ruleSetSchema, type RuleSet, type RuleSetInput } from '@puantaj/schemas';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { CalendarCheck, MoreHorizontal, Pencil, Plus, Power, Scale, Shapes } from 'lucide-react';
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { useFormat } from '@/hooks/use-format';
import { api } from '@/lib/api';
import { canManageCompany, canViewPayRules, useMe, type Me } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { RULE_SETS_KEY, useRuleSets, type RuleSetItem } from '@/lib/rule-sets';

/** Named rule sets sites and firms share (AGENTS.md: Pay rule sets). Owners and admins manage them; accountants look. */
export function RuleSetsPage() {
  const { t } = useTranslation();
  const me = useMe().data;
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title={t('ruleSets.title')}
        description={t('ruleSets.description')}
        actions={
          canManageCompany(me) && (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              {t('ruleSets.create')}
            </Button>
          )
        }
      />
      <RequireAccess allowed={canViewPayRules}>
        {(verified) => <RuleSetsView me={verified} creating={creating} onCreatingChange={setCreating} />}
      </RequireAccess>
    </>
  );
}

function RuleSetsView({ me, creating, onCreatingChange }: { me: Me; creating: boolean; onCreatingChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const format = useFormat();
  const queryClient = useQueryClient();
  const sets = useRuleSets();
  const manages = canManageCompany(me);
  const [editing, setEditing] = useState<RuleSetItem | null>(null);
  const [toggling, setToggling] = useState<RuleSetItem | null>(null);
  const rows = useMemo(() => sets.data?.filter((s) => s.name !== null), [sets.data]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: RULE_SETS_KEY });

  const columns = useMemo<ColumnDef<RuleSetItem, unknown>[]>(
    () => [
      {
        id: 'name',
        accessorKey: 'name',
        header: t('ruleSets.name'),
        cell: ({ row }) => (
          <Link to={`/settings/rule-sets/${row.original.id}/pay-rules`} className="font-medium underline-offset-4 hover:underline">
            {row.original.name}
          </Link>
        ),
      },
      {
        id: 'rulesFrom',
        header: t('payRules.from'),
        enableSorting: false,
        cell: ({ row }) => {
          const from = row.original.rulesFrom;
          return from ? format.month(from.year, from.month) : <StatusBadge tone="warning">{t('ruleSets.noRules')}</StatusBadge>;
        },
      },
      {
        id: 'usedBy',
        header: t('ruleSets.usedByColumn'),
        enableSorting: false,
        cell: ({ row }) => {
          const { sites, firms } = row.original.usedBy;
          return [...sites, ...firms].map((x) => x.name).join(', ') || '—';
        },
      },
      {
        id: 'status',
        header: t('ruleSets.status'),
        enableSorting: false,
        cell: ({ row }) =>
          row.original.isActive ? (
            <StatusBadge tone="success">{t('ruleSets.active')}</StatusBadge>
          ) : (
            <StatusBadge tone="neutral">{t('ruleSets.inactive')}</StatusBadge>
          ),
      },
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
              <DropdownMenuItem asChild>
                <Link to={`/settings/rule-sets/${row.original.id}/pay-rules`}>
                  <Scale aria-hidden />
                  {t('nav.payRules')}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to={`/settings/rule-sets/${row.original.id}/working-days`}>
                  <CalendarCheck aria-hidden />
                  {t('nav.workingDays')}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to={`/settings/rule-sets/${row.original.id}/categories`}>
                  <Shapes aria-hidden />
                  {t('ruleSetCategories.link')}
                </Link>
              </DropdownMenuItem>
              {manages && (
                <>
                  <DropdownMenuItem onSelect={() => setEditing(row.original)}>
                    <Pencil aria-hidden />
                    {t('ruleSets.rename')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setToggling(row.original)}>
                    <Power aria-hidden />
                    {row.original.isActive ? t('ruleSets.deactivate') : t('ruleSets.reactivate')}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [t, format, manages],
  );

  const closeDialog = () => {
    onCreatingChange(false);
    setEditing(null);
  };

  return (
    <>
      <DataTable
        columns={columns}
        data={rows}
        isLoading={sets.isPending}
        isError={sets.isError}
        onRetry={() => sets.refetch()}
        totalCount={rows?.length}
        searchable
        searchText={(s) => s.name ?? ''}
        emptyTitle={t('ruleSets.empty')}
        emptyDescription={t('ruleSets.emptyDescription')}
      />
      {(creating || editing) && (
        <RuleSetDialog
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
        title={toggling?.isActive ? t('ruleSets.confirmDeactivate.title') : t('ruleSets.confirmReactivate.title')}
        description={
          toggling
            ? toggling.isActive
              ? t('ruleSets.confirmDeactivate.description', { name: toggling.name })
              : t('ruleSets.confirmReactivate.description', { name: toggling.name })
            : ''
        }
        confirmLabel={toggling?.isActive ? t('ruleSets.deactivate') : t('ruleSets.reactivate')}
        destructive={toggling?.isActive}
        onConfirm={async () => {
          if (!toggling) return;
          await api.patch(`/rule-sets/${toggling.id}`, { isActive: !toggling.isActive });
          toast.success(t('common.saved'));
          await refresh();
        }}
      />
    </>
  );
}

/** Adds a rule set, or renames one. */
function RuleSetDialog({ current, onClose, onSaved }: { current: RuleSetItem | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [formError, setFormError] = useState<string>();
  const form = useForm<RuleSetInput, unknown, RuleSet>({
    resolver: zodResolver(ruleSetSchema),
    defaultValues: { name: current?.name ?? '' },
  });
  const { errors } = form.formState;
  const save = useMutation({
    mutationFn: (values: RuleSet) => (current ? api.patch(`/rule-sets/${current.id}`, values) : api.post('/rule-sets', values)),
    onSuccess: onSaved,
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{current ? t('ruleSets.rename') : t('ruleSets.create')}</DialogTitle>
          <DialogDescription>{t('ruleSets.dialogDescription')}</DialogDescription>
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
          <Field id="rs-name" label={t('ruleSets.name')} error={errors.name}>
            <Input {...fieldControlProps('rs-name', errors.name)} {...form.register('name')} autoComplete="off" />
          </Field>
          <FormActions submitLabel={current ? t('common.save') : t('ruleSets.create')} pending={save.isPending} onCancel={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
