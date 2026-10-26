import { zodResolver } from '@hookform/resolvers/zod';
import { shiftSchema, type Shift, type ShiftInput } from '@puantaj/schemas';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Plus } from 'lucide-react';
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
import { useFormat } from '@/hooks/use-format';
import { api } from '@/lib/api';
import { canManageCompany, useMe } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { SHIFTS_KEY, useShifts, WORKERS_KEY, type ShiftItem } from '@/lib/organisation';

/** The company's shifts and their normal hours per day (AGENTS.md: Shifts). */
export function ShiftsPage() {
  const { t } = useTranslation();
  const me = useMe().data;
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title={t('shifts.title')}
        description={t('shifts.description')}
        actions={
          canManageCompany(me) && (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              {t('shifts.create')}
            </Button>
          )
        }
      />
      <RequireAccess allowed={canManageCompany}>
        {() => <ShiftsView creating={creating} onCreatingChange={setCreating} />}
      </RequireAccess>
    </>
  );
}

function ShiftsView({ creating, onCreatingChange }: { creating: boolean; onCreatingChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const format = useFormat();
  const queryClient = useQueryClient();
  const shifts = useShifts();
  const [editing, setEditing] = useState<ShiftItem | null>(null);
  const [archiving, setArchiving] = useState<ShiftItem | null>(null);

  // Workers show their shift's name.
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: SHIFTS_KEY }),
      queryClient.invalidateQueries({ queryKey: WORKERS_KEY }),
    ]);

  const columns = useMemo<ColumnDef<ShiftItem, unknown>[]>(
    () => [
      {
        accessorKey: 'name',
        header: t('shifts.name'),
        cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      },
      {
        accessorKey: 'normalHoursPerDay',
        header: t('shifts.normalHoursPerDay'),
        sortingFn: (a, b) => Number(a.original.normalHoursPerDay) - Number(b.original.normalHoursPerDay),
        cell: ({ row }) => <span className="tabular-nums">{format.number(row.original.normalHoursPerDay)}</span>,
      },
      {
        accessorKey: 'isActive',
        header: t('users.status'),
        cell: ({ row }) =>
          row.original.isActive ? (
            <StatusBadge tone="success">{t('shifts.offered')}</StatusBadge>
          ) : (
            <StatusBadge tone="neutral">{t('shifts.archived')}</StatusBadge>
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
              <DropdownMenuItem onSelect={() => setEditing(row.original)}>
                <Pencil aria-hidden />
                {t('shifts.edit')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setArchiving(row.original)}>
                {row.original.isActive ? <Archive aria-hidden /> : <ArchiveRestore aria-hidden />}
                {row.original.isActive ? t('shifts.archive') : t('shifts.restore')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [t, format],
  );

  const archive = archiving?.isActive ? 'archive' : 'restore';
  return (
    <>
      <DataTable
        columns={columns}
        data={shifts.data}
        isLoading={shifts.isPending}
        isError={shifts.isError}
        onRetry={() => shifts.refetch()}
        emptyTitle={t('shifts.empty')}
        emptyDescription={t('shifts.emptyDescription')}
      />
      <ShiftDialog
        open={creating || editing !== null}
        shift={editing}
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
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => !open && setArchiving(null)}
        title={t(`shifts.confirm.${archive}.title`)}
        description={archiving ? t(`shifts.confirm.${archive}.description`, { name: archiving.name }) : ''}
        confirmLabel={t(`shifts.confirm.${archive}.button`)}
        destructive={archive === 'archive'}
        onConfirm={async () => {
          if (!archiving) return;
          await api.patch(`/shifts/${archiving.id}`, { isActive: !archiving.isActive });
          toast.success(t('common.saved'));
          await refresh();
        }}
      />
    </>
  );
}

const EMPTY_SHIFT: ShiftInput = { name: '', normalHoursPerDay: '' };

/** Creates a shift, or edits one (only its name once a worker has had it). */
function ShiftDialog({
  open,
  shift,
  onClose,
  onSaved,
}: {
  open: boolean;
  shift: ShiftItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const [formError, setFormError] = useState<string>();
  const form = useForm<ShiftInput, unknown, Shift>({
    resolver: zodResolver(shiftSchema),
    values: shift ? { name: shift.name, normalHoursPerDay: shift.normalHoursPerDay } : EMPTY_SHIFT,
  });
  const { errors } = form.formState;

  const close = () => {
    form.reset(EMPTY_SHIFT);
    setFormError(undefined);
    onClose();
  };

  const save = useMutation({
    mutationFn: (values: Shift) => (shift ? api.patch(`/shifts/${shift.id}`, values) : api.post('/shifts', values)),
    onSuccess: () => {
      form.reset(EMPTY_SHIFT);
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
          <DialogTitle>{shift ? t('shifts.edit') : t('shifts.create')}</DialogTitle>
          <DialogDescription>{t('shifts.dialogDescription')}</DialogDescription>
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
          <Field id="sh-name" label={t('shifts.name')} error={errors.name}>
            <Input {...fieldControlProps('sh-name', errors.name)} {...form.register('name')} autoComplete="off" />
          </Field>
          {shift?.inUse ? (
            // Fixed once a worker has had the shift; the form sends them back unchanged.
            <div className="space-y-2">
              <dl>
                <dt className="text-sm text-muted-foreground">{t('shifts.normalHoursPerDay')}</dt>
                <dd className="font-medium tabular-nums">{format.number(shift.normalHoursPerDay)}</dd>
              </dl>
              <p className="text-sm text-muted-foreground">{t('shifts.hoursFixed')}</p>
            </div>
          ) : (
            <Field
              id="sh-hours"
              label={t('shifts.normalHoursPerDay')}
              error={errors.normalHoursPerDay}
              hint={t('shifts.normalHoursHint')}
            >
              <Input
                {...fieldControlProps('sh-hours', errors.normalHoursPerDay)}
                {...form.register('normalHoursPerDay')}
                inputMode="decimal"
                autoComplete="off"
              />
            </Field>
          )}
          <FormActions submitLabel={shift ? t('common.save') : t('shifts.create')} pending={save.isPending} onCancel={close} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
