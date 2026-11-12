import { zodResolver } from '@hookform/resolvers/zod';
import { positionSchema, type Position, type PositionInput } from '@puantaj/schemas';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Archive, ArchiveRestore, Merge, MoreHorizontal, Pencil, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
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
import { canManageCompany, inCompany, useMe } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { POSITIONS_KEY, usePositions, WORKERS_KEY, type PositionItem } from '@/lib/organisation';

/** The company's positions (AGENTS.md: Positions): everyone sees the list, an owner or admin changes it. */
export function PositionsPage() {
  const { t } = useTranslation();
  const me = useMe().data;
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title={t('positions.title')}
        description={t('positions.description')}
        actions={
          canManageCompany(me) && (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              {t('positions.create')}
            </Button>
          )
        }
      />
      <RequireAccess allowed={inCompany}>
        {(user) => <PositionsView canManage={canManageCompany(user)} creating={creating} onCreatingChange={setCreating} />}
      </RequireAccess>
    </>
  );
}

function PositionsView({
  canManage,
  creating,
  onCreatingChange,
}: {
  canManage: boolean;
  creating: boolean;
  onCreatingChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const positions = usePositions();
  const [editing, setEditing] = useState<PositionItem | null>(null);
  const [archiving, setArchiving] = useState<PositionItem | null>(null);
  const [merging, setMerging] = useState<PositionItem | null>(null);

  // Workers show their position's name.
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: POSITIONS_KEY }),
      queryClient.invalidateQueries({ queryKey: WORKERS_KEY }),
    ]);

  const columns = useMemo<ColumnDef<PositionItem, unknown>[]>(() => {
    const view: ColumnDef<PositionItem, unknown>[] = [
      {
        accessorKey: 'name',
        header: t('positions.name'),
        cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      },
      {
        accessorKey: 'uses',
        header: t('positions.uses'),
        cell: ({ row }) => <span className="tabular-nums">{row.original.uses}</span>,
      },
      {
        accessorKey: 'isActive',
        header: t('users.status'),
        cell: ({ row }) =>
          row.original.isActive ? (
            <StatusBadge tone="success">{t('positions.offered')}</StatusBadge>
          ) : (
            <StatusBadge tone="neutral">{t('positions.archived')}</StatusBadge>
          ),
      },
    ];
    if (!canManage) return view;
    return [
      ...view,
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
              <DropdownMenuItem onSelect={() => setEditing(row.original)}>
                <Pencil aria-hidden />
                {t('positions.edit')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setMerging(row.original)}>
                <Merge aria-hidden />
                {t('positions.merge')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setArchiving(row.original)}>
                {row.original.isActive ? <Archive aria-hidden /> : <ArchiveRestore aria-hidden />}
                {row.original.isActive ? t('positions.archive') : t('positions.restore')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ];
  }, [t, canManage]);

  const archive = archiving?.isActive ? 'archive' : 'restore';
  return (
    <>
      <DataTable
        columns={columns}
        data={positions.data}
        isLoading={positions.isPending}
        isError={positions.isError}
        onRetry={() => positions.refetch()}
        searchable
        emptyTitle={t('positions.empty')}
        emptyDescription={t('positions.emptyDescription')}
      />
      <PositionDialog
        open={creating || editing !== null}
        position={editing}
        onClose={() => {
          onCreatingChange(false);
          setEditing(null);
        }}
        onSaved={async () => {
          onCreatingChange(false);
          setEditing(null);
          toast.success(t('common.saved'));
          await refresh();
        }}
      />
      {merging && (
        <MergeDialog
          position={merging}
          others={(positions.data ?? []).filter((p) => p.id !== merging.id)}
          onClose={() => setMerging(null)}
          onMerged={async () => {
            setMerging(null);
            toast.success(t('common.saved'));
            await refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => !open && setArchiving(null)}
        title={t(`positions.confirm.${archive}.title`)}
        description={archiving ? t(`positions.confirm.${archive}.description`, { name: archiving.name }) : ''}
        confirmLabel={t(`positions.confirm.${archive}.button`)}
        destructive={archive === 'archive'}
        onConfirm={async () => {
          if (!archiving) return;
          await api.patch(`/positions/${archiving.id}`, { isActive: !archiving.isActive });
          toast.success(t('common.saved'));
          await refresh();
        }}
      />
    </>
  );
}

const EMPTY_POSITION: PositionInput = { name: '' };

/** Creates a position, or renames one. */
function PositionDialog({
  open,
  position,
  onClose,
  onSaved,
}: {
  open: boolean;
  position: PositionItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [formError, setFormError] = useState<string>();
  const form = useForm<PositionInput, unknown, Position>({
    resolver: zodResolver(positionSchema),
    values: position ? { name: position.name } : EMPTY_POSITION,
  });
  const { errors } = form.formState;

  const close = () => {
    form.reset(EMPTY_POSITION);
    setFormError(undefined);
    onClose();
  };

  const save = useMutation({
    mutationFn: (values: Position) => (position ? api.patch(`/positions/${position.id}`, values) : api.post('/positions', values)),
    onSuccess: () => {
      form.reset(EMPTY_POSITION);
      onSaved();
    },
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !save.isPending && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{position ? t('positions.edit') : t('positions.create')}</DialogTitle>
          <DialogDescription>{t('positions.dialogDescription')}</DialogDescription>
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
          <Field id="pos-name" label={t('positions.name')} error={errors.name}>
            <Input {...fieldControlProps('pos-name', errors.name)} {...form.register('name')} autoComplete="off" />
          </Field>
          <FormActions submitLabel={position ? t('common.save') : t('positions.create')} pending={save.isPending} onCancel={close} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Merges a position into another one: its workers' history moves there and it is removed. */
function MergeDialog({
  position,
  others,
  onClose,
  onMerged,
}: {
  position: PositionItem;
  others: PositionItem[];
  onClose: () => void;
  onMerged: () => void;
}) {
  const { t } = useTranslation();
  const [intoId, setIntoId] = useState('');
  const [formError, setFormError] = useState<string>();
  const into = others.find((p) => p.id === intoId);

  const merge = useMutation({
    mutationFn: () => api.post(`/positions/${position.id}/merge`, { intoId }),
    onSuccess: onMerged,
    onError: (error) => setFormError(errorMessage(t, error)),
  });

  return (
    <Dialog open onOpenChange={(next) => !next && !merge.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('positions.mergeTitle', { name: position.name })}</DialogTitle>
          <DialogDescription>{t('positions.mergeDescription')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setFormError(undefined);
            if (intoId) merge.mutate();
          }}
        >
          <FormError message={formError} />
          <Field id="pos-into" label={t('positions.mergeInto')}>
            <Select value={intoId} onValueChange={setIntoId}>
              <SelectTrigger id="pos-into" className="w-full">
                <SelectValue placeholder={t('positions.choose')} />
              </SelectTrigger>
              <SelectContent>
                {others.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {into && (
            <StatusBadge tone="warning">
              {t('positions.mergeWarning', { name: position.name, into: into.name, count: position.uses })}
            </StatusBadge>
          )}
          <FormActions submitLabel={t('positions.merge')} pending={merge.isPending} onCancel={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
