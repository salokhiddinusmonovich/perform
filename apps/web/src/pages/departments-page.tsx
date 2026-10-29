import { zodResolver } from '@hookform/resolvers/zod';
import { departmentSchema, type Department, type DepartmentInput } from '@puantaj/schemas';
import { useMutation } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import type { TFunction } from 'i18next';
import { CornerDownRight, MoreHorizontal, Pencil, Plus, Power } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable } from '@/components/data-table';
import { DepartmentSelect } from '@/components/department-select';
import { Field, fieldControlProps, FormActions, FormError } from '@/components/form';
import { PageHeader } from '@/components/page-header';
import { RequireAccess } from '@/components/require-access';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { canManageCompany, seesDepartments, usesDepartments, useMe, type Me } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { today } from '@/lib/format';
import {
  departmentTree,
  useDepartments,
  useRefreshOrganisation,
  stillPlaced,
  useSites,
  useWorkers,
  withSubDepartments,
  type DepartmentNode,
} from '@/lib/organisation';

/**
 * The company's departments (AGENTS.md: Departments) as a tree. Owners and admins manage them;
 * accountants and project managers only look. Switching them on is in Company settings.
 */
export function DepartmentsPage() {
  const { t } = useTranslation();
  const me = useMe().data;
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title={t('departments.title')}
        description={t('departments.description')}
        actions={
          canManageCompany(me) && (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              {t('departments.create')}
            </Button>
          )
        }
      />
      <RequireAccess allowed={seesDepartments}>
        {(verified) => <DepartmentsView me={verified} creating={creating} onCreatingChange={setCreating} />}
      </RequireAccess>
    </>
  );
}

/** What the department dialog is doing: adding (under a parent, or at the top) or editing one. */
type Editing = { kind: 'create'; parentId: string | null } | { kind: 'edit'; department: DepartmentNode };

function DepartmentsView({
  me,
  creating,
  onCreatingChange,
}: {
  me: Me;
  creating: boolean;
  onCreatingChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const departments = useDepartments();
  const sites = useSites();
  const workers = useWorkers();
  const refresh = useRefreshOrganisation();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [toggling, setToggling] = useState<DepartmentNode | null>(null);

  const tree = useMemo(() => departmentTree(departments.data ?? []), [departments.data]);
  // Counted here from the lists the page has: active brigades, and workers placed in the department
  // today, each including its sub-departments (like every department total).
  // Project managers see only their sites' brigades and workers, so the counts cover those.
  const working = useMemo(() => stillPlaced(workers.data ?? [], today()), [workers.data]);
  const counts = useMemo(() => {
    const teams = (sites.data ?? []).flatMap((s) => s.teams).filter((x) => x.isActive);
    return new Map(
      tree.map((d) => {
        const ids = withSubDepartments(tree, d.id);
        return [
          d.id,
          {
            teams: teams.filter((x) => x.departmentId && ids.has(x.departmentId)).length,
            workers: working.filter((w) => w.placement.departmentId && ids.has(w.placement.departmentId)).length,
          },
        ];
      }),
    );
  }, [tree, sites.data, working]);
  const missing = working.filter((w) => !w.placement.departmentId).length;
  const manages = canManageCompany(me);

  const columns = useMemo<ColumnDef<DepartmentNode, unknown>[]>(
    () => [
      {
        id: 'name',
        accessorFn: (d) => d.path,
        header: t('departments.name'),
        enableSorting: false,
        cell: ({ row }) => {
          const d = row.original;
          const parent = d.parentId ? tree.find((x) => x.id === d.parentId) : undefined;
          return (
            <div className="min-w-40">
              <div className="flex items-center gap-1.5 font-medium">
                {d.depth > 0 && <CornerDownRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
                <span>{d.name}</span>
                {d.code && <span className="text-muted-foreground">· {d.code}</span>}
              </div>
              {parent && <div className="text-sm text-muted-foreground">{t('departments.under', { name: parent.path })}</div>}
            </div>
          );
        },
      },
      {
        id: 'teams',
        header: t('departments.teams'),
        enableSorting: false,
        cell: ({ row }) => <span className="tabular-nums">{counts.get(row.original.id)?.teams ?? 0}</span>,
      },
      {
        id: 'workers',
        header: t('departments.workers'),
        enableSorting: false,
        cell: ({ row }) => <span className="tabular-nums">{counts.get(row.original.id)?.workers ?? 0}</span>,
      },
      {
        id: 'status',
        header: t('departments.status'),
        enableSorting: false,
        cell: ({ row }) =>
          row.original.isActive ? (
            <StatusBadge tone="success">{t('departments.active')}</StatusBadge>
          ) : (
            <StatusBadge tone="neutral">{t('departments.closed')}</StatusBadge>
          ),
      },
      // Only owners and admins change departments; everyone else only looks.
      ...(manages ? [actionsColumn(t, setEditing, setToggling)] : []),
    ],
    [t, tree, counts, manages],
  );

  const dialog: Editing | null = creating ? { kind: 'create', parentId: null } : editing;
  const closeDialog = () => {
    onCreatingChange(false);
    setEditing(null);
  };

  return (
    <div className="space-y-6">
      <DepartmentsStatus me={me} missing={missing} />
      <DataTable
        columns={columns}
        data={tree}
        isLoading={departments.isPending}
        isError={departments.isError}
        onRetry={() => departments.refetch()}
        searchable
        searchText={(d) => [d.path, d.code].filter(Boolean).join(' ')}
        emptyTitle={t('departments.empty')}
        emptyDescription={t('departments.emptyDescription')}
      />
      {dialog && (
        <DepartmentDialog
          key={dialog.kind === 'edit' ? dialog.department.id : `new-${dialog.parentId ?? 'top'}`}
          editing={dialog}
          tree={tree}
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
        title={toggling?.isActive ? t('departments.confirmClose.title') : t('departments.confirmReopen.title')}
        description={
          toggling
            ? toggling.isActive
              ? t('departments.confirmClose.description', { name: toggling.path })
              : t('departments.confirmReopen.description', { name: toggling.path })
            : ''
        }
        confirmLabel={toggling?.isActive ? t('departments.close') : t('departments.reopen')}
        destructive={toggling?.isActive}
        onConfirm={async () => {
          if (!toggling) return;
          await api.patch(`/departments/${toggling.id}`, { isActive: !toggling.isActive });
          toast.success(t('common.saved'));
          await refresh();
        }}
      />
    </div>
  );
}

/** The row menu: edit, add a sub-department, close or reopen (owners and admins). */
function actionsColumn(
  t: TFunction,
  setEditing: (editing: Editing) => void,
  setToggling: (department: DepartmentNode) => void,
): ColumnDef<DepartmentNode, unknown> {
  return {
    id: 'actions',
    header: () => <span className="sr-only">{t('common.actions')}</span>,
    enableSorting: false,
    cell: ({ row }) => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={t('common.actionsFor', { name: row.original.path })}>
            <MoreHorizontal aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEditing({ kind: 'edit', department: row.original })}>
            <Pencil aria-hidden />
            {t('departments.edit')}
          </DropdownMenuItem>
          {row.original.isActive && (
            <DropdownMenuItem onSelect={() => setEditing({ kind: 'create', parentId: row.original.id })}>
              <CornerDownRight aria-hidden />
              {t('departments.addSub')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setToggling(row.original)}>
            <Power aria-hidden />
            {row.original.isActive ? t('departments.close') : t('departments.reopen')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  };
}

/**
 * Whether the company uses departments (switched in Company settings), and the workers still
 * without one while it does. Only owners and admins see this page while departments are off.
 */
function DepartmentsStatus({ me, missing }: { me: Me; missing: number }) {
  const { t } = useTranslation();
  const enabled = usesDepartments(me);
  return (
    <div className="space-y-2 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        {enabled ? (
          <StatusBadge tone="success">{t('departments.on')}</StatusBadge>
        ) : (
          <StatusBadge tone="neutral">{t('departments.off')}</StatusBadge>
        )}
        <span className="text-muted-foreground">{enabled ? t('departments.onHint') : t('departments.offHint')}</span>
        {canManageCompany(me) && (
          <Link to="/settings/company" className="underline underline-offset-4">
            {t('departments.settingLink')}
          </Link>
        )}
      </p>
      {me.activeCompany?.role === 'PROJECT_MANAGER' && (
        <p className="text-muted-foreground">{t('departments.yourSitesOnly')}</p>
      )}
      {enabled && missing > 0 && (
        <p className="flex flex-wrap items-center gap-2">
          <StatusBadge tone="warning">{t('departments.missing', { count: missing })}</StatusBadge>
          <Link to="/workers" className="underline underline-offset-4">
            {t('departments.missingLink')}
          </Link>
        </p>
      )}
    </div>
  );
}

const EMPTY: DepartmentInput = { name: '', code: '', parentId: '' };

/** Adds a department (at the top or under another), or renames or moves one. */
function DepartmentDialog({
  editing,
  tree,
  onClose,
  onSaved,
}: {
  editing: Editing;
  tree: DepartmentNode[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [formError, setFormError] = useState<string>();
  const current = editing.kind === 'edit' ? editing.department : null;
  const form = useForm<DepartmentInput, unknown, Department>({
    resolver: zodResolver(departmentSchema),
    defaultValues: current
      ? { name: current.name, code: current.code ?? '', parentId: current.parentId ?? '' }
      : { ...EMPTY, parentId: editing.kind === 'create' ? (editing.parentId ?? '') : '' },
  });
  const { errors } = form.formState;
  // A department can't move under itself or its own sub-departments.
  const exclude = useMemo(() => (current ? withSubDepartments(tree, current.id) : undefined), [current, tree]);

  const save = useMutation({
    mutationFn: (values: Department) =>
      current ? api.patch(`/departments/${current.id}`, values) : api.post('/departments', values),
    onSuccess: onSaved,
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{current ? t('departments.edit') : t('departments.create')}</DialogTitle>
          <DialogDescription>{t('departments.dialogDescription')}</DialogDescription>
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
          <Field id="d-name" label={t('departments.name')} error={errors.name}>
            <Input {...fieldControlProps('d-name', errors.name)} {...form.register('name')} autoComplete="off" />
          </Field>
          <Field id="d-code" label={t('departments.code')} error={errors.code} hint={t('departments.codeHint')}>
            <Input {...fieldControlProps('d-code', errors.code)} {...form.register('code')} autoComplete="off" />
          </Field>
          <Controller
            control={form.control}
            name="parentId"
            render={({ field }) => (
              <Field id="d-parent" label={t('departments.parent')} error={errors.parentId} hint={t('departments.parentHint')}>
                <DepartmentSelect
                  id="d-parent"
                  departments={tree}
                  value={field.value ?? ''}
                  onChange={field.onChange}
                  keep={current?.parentId}
                  exclude={exclude}
                  noneLabel={t('departments.topLevel')}
                  invalid={!!errors.parentId}
                />
              </Field>
            )}
          />
          <FormActions submitLabel={current ? t('common.save') : t('departments.create')} pending={save.isPending} onCancel={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
