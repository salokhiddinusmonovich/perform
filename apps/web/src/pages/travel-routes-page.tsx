import { zodResolver } from '@hookform/resolvers/zod';
import { travelRouteSchema, type TravelRoute, type TravelRouteInput } from '@puantaj/schemas';
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
import { TRAVEL_ROUTES_KEY, useTravelRoutes, WORKERS_KEY, type TravelRouteItem } from '@/lib/organisation';

/** The company's travel routes and their pay per day worked (AGENTS.md: Travel pay). */
export function TravelRoutesPage() {
  const { t } = useTranslation();
  const me = useMe().data;
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title={t('travelRoutes.title')}
        description={t('travelRoutes.description')}
        actions={
          canManageCompany(me) && (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              {t('travelRoutes.create')}
            </Button>
          )
        }
      />
      <RequireAccess allowed={canManageCompany}>
        {(me) => <TravelRoutesView currency={me.activeCompany!.currency} creating={creating} onCreatingChange={setCreating} />}
      </RequireAccess>
    </>
  );
}

function TravelRoutesView({
  currency,
  creating,
  onCreatingChange,
}: {
  currency: string;
  creating: boolean;
  onCreatingChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const queryClient = useQueryClient();
  const routes = useTravelRoutes();
  const [editing, setEditing] = useState<TravelRouteItem | null>(null);
  const [archiving, setArchiving] = useState<TravelRouteItem | null>(null);

  // Workers show their route's name.
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: TRAVEL_ROUTES_KEY }),
      queryClient.invalidateQueries({ queryKey: WORKERS_KEY }),
    ]);

  const columns = useMemo<ColumnDef<TravelRouteItem, unknown>[]>(
    () => [
      {
        accessorKey: 'name',
        header: t('travelRoutes.name'),
        cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      },
      {
        accessorKey: 'amountPerDay',
        header: t('travelRoutes.amountPerDay'),
        sortingFn: (a, b) => Number(a.original.amountPerDay) - Number(b.original.amountPerDay),
        cell: ({ row }) => <span className="tabular-nums">{format.money(row.original.amountPerDay, currency)}</span>,
      },
      {
        accessorKey: 'isActive',
        header: t('users.status'),
        cell: ({ row }) =>
          row.original.isActive ? (
            <StatusBadge tone="success">{t('travelRoutes.offered')}</StatusBadge>
          ) : (
            <StatusBadge tone="neutral">{t('travelRoutes.archived')}</StatusBadge>
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
                {t('travelRoutes.edit')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setArchiving(row.original)}>
                {row.original.isActive ? <Archive aria-hidden /> : <ArchiveRestore aria-hidden />}
                {row.original.isActive ? t('travelRoutes.archive') : t('travelRoutes.restore')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [t, format, currency],
  );

  const archive = archiving?.isActive ? 'archive' : 'restore';
  return (
    <>
      <DataTable
        columns={columns}
        data={routes.data}
        isLoading={routes.isPending}
        isError={routes.isError}
        onRetry={() => routes.refetch()}
        emptyTitle={t('travelRoutes.empty')}
        emptyDescription={t('travelRoutes.emptyDescription')}
      />
      <TravelRouteDialog
        open={creating || editing !== null}
        route={editing}
        currency={currency}
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
        title={t(`travelRoutes.confirm.${archive}.title`)}
        description={archiving ? t(`travelRoutes.confirm.${archive}.description`, { name: archiving.name }) : ''}
        confirmLabel={t(`travelRoutes.confirm.${archive}.button`)}
        destructive={archive === 'archive'}
        onConfirm={async () => {
          if (!archiving) return;
          await api.patch(`/travel-routes/${archiving.id}`, { isActive: !archiving.isActive });
          toast.success(t('common.saved'));
          await refresh();
        }}
      />
    </>
  );
}

const EMPTY_ROUTE: TravelRouteInput = { name: '', amountPerDay: '' };

/** Creates a route, or edits one (only its name once a placement has had it). */
function TravelRouteDialog({
  open,
  route,
  currency,
  onClose,
  onSaved,
}: {
  open: boolean;
  route: TravelRouteItem | null;
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const [formError, setFormError] = useState<string>();
  const form = useForm<TravelRouteInput, unknown, TravelRoute>({
    resolver: zodResolver(travelRouteSchema),
    values: route ? { name: route.name, amountPerDay: route.amountPerDay } : EMPTY_ROUTE,
  });
  const { errors } = form.formState;

  const close = () => {
    form.reset(EMPTY_ROUTE);
    setFormError(undefined);
    onClose();
  };

  const save = useMutation({
    mutationFn: (values: TravelRoute) =>
      route ? api.patch(`/travel-routes/${route.id}`, values) : api.post('/travel-routes', values),
    onSuccess: () => {
      form.reset(EMPTY_ROUTE);
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
          <DialogTitle>{route ? t('travelRoutes.edit') : t('travelRoutes.create')}</DialogTitle>
          <DialogDescription>{t('travelRoutes.dialogDescription')}</DialogDescription>
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
          <Field id="tr-name" label={t('travelRoutes.name')} error={errors.name}>
            <Input {...fieldControlProps('tr-name', errors.name)} {...form.register('name')} autoComplete="off" />
          </Field>
          {route?.inUse ? (
            // Fixed once a placement has had the route; the form sends it back unchanged.
            <div className="space-y-2">
              <dl>
                <dt className="text-sm text-muted-foreground">{t('travelRoutes.amountPerDay')}</dt>
                <dd className="font-medium tabular-nums">{format.money(route.amountPerDay, currency)}</dd>
              </dl>
              <p className="text-sm text-muted-foreground">{t('travelRoutes.amountFixed')}</p>
            </div>
          ) : (
            <Field
              id="tr-amount"
              label={t('travelRoutes.amountPerDayIn', { currency })}
              error={errors.amountPerDay}
              hint={t('travelRoutes.amountHint')}
            >
              <Input
                {...fieldControlProps('tr-amount', errors.amountPerDay)}
                {...form.register('amountPerDay')}
                inputMode="decimal"
                autoComplete="off"
              />
            </Field>
          )}
          <FormActions
            submitLabel={route ? t('common.save') : t('travelRoutes.create')}
            pending={save.isPending}
            onCancel={close}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}
