import { zodResolver } from '@hookform/resolvers/zod';
import {
  categoryOptionSchema,
  updateWorkerCategorySchema,
  workerCategorySchema,
  type CategoryOption,
  type CategoryOptionInput,
  type UpdateWorkerCategory,
  type WorkerCategory,
  type WorkerCategoryInput,
} from '@puantaj/schemas';
import { useMutation } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { ListPlus, MoreHorizontal, Pencil, Plus, Power, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Controller, useForm, type FieldError } from 'react-hook-form';
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
import { api } from '@/lib/api';
import { canManageCompany, seesWorkerCategories, useMe, type Me } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { useRefreshOrganisation, useWorkerCategories, useWorkers, type WorkerCategoryItem } from '@/lib/organisation';

type OptionItem = WorkerCategoryItem['options'][number];

/**
 * The company's worker categories (AGENTS.md: Worker categories), e.g. Direct/Indirect or
 * Local/Foreign, each with its options. Owners and admins manage them; accountants and
 * project managers only look. They never change pay.
 */
export function WorkerCategoriesPage() {
  const { t } = useTranslation();
  const me = useMe().data;
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title={t('workerCategories.title')}
        description={t('workerCategories.description')}
        actions={
          canManageCompany(me) && (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              {t('workerCategories.create')}
            </Button>
          )
        }
      />
      <RequireAccess allowed={seesWorkerCategories}>
        {(verified) => <CategoriesView me={verified} creating={creating} onCreatingChange={setCreating} />}
      </RequireAccess>
    </>
  );
}

/** What a confirmation dialog closes or reopens: a category, or one of its options. */
type Toggling = { category: WorkerCategoryItem; option: OptionItem | null };

function CategoriesView({ me, creating, onCreatingChange }: { me: Me; creating: boolean; onCreatingChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const categories = useWorkerCategories();
  const workers = useWorkers();
  const refresh = useRefreshOrganisation();
  const [renaming, setRenaming] = useState<WorkerCategoryItem | null>(null);
  const [optionsOf, setOptionsOf] = useState<WorkerCategoryItem | null>(null);
  const [toggling, setToggling] = useState<Toggling | null>(null);
  const manages = canManageCompany(me);

  // Counted from the list the page has: project managers see only their sites' workers.
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const w of workers.data ?? []) for (const optionId of Object.values(w.categories)) out.set(optionId, (out.get(optionId) ?? 0) + 1);
    return out;
  }, [workers.data]);

  const columns = useMemo<ColumnDef<WorkerCategoryItem, unknown>[]>(
    () => [
      {
        id: 'name',
        accessorKey: 'name',
        header: t('workerCategories.name'),
        cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      },
      {
        id: 'options',
        header: t('workerCategories.options'),
        enableSorting: false,
        cell: ({ row }) => (
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {row.original.options.map((o) => (
              <li key={o.id} className={o.isActive ? undefined : 'text-muted-foreground'}>
                {o.name} <span className="tabular-nums text-muted-foreground">({counts.get(o.id) ?? 0})</span>
                {!o.isActive && <span className="sr-only"> {t('workerCategories.closed')}</span>}
              </li>
            ))}
          </ul>
        ),
      },
      {
        id: 'status',
        header: t('workerCategories.status'),
        enableSorting: false,
        cell: ({ row }) =>
          row.original.isActive ? (
            <StatusBadge tone="success">{t('workerCategories.active')}</StatusBadge>
          ) : (
            <StatusBadge tone="neutral">{t('workerCategories.closed')}</StatusBadge>
          ),
      },
      ...(manages
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
                    <DropdownMenuItem onSelect={() => setRenaming(row.original)}>
                      <Pencil aria-hidden />
                      {t('workerCategories.rename')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setOptionsOf(row.original)}>
                      <ListPlus aria-hidden />
                      {t('workerCategories.manageOptions')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setToggling({ category: row.original, option: null })}>
                      <Power aria-hidden />
                      {row.original.isActive ? t('workerCategories.close') : t('workerCategories.reopen')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ),
            } satisfies ColumnDef<WorkerCategoryItem, unknown>,
          ]
        : []),
    ],
    [t, counts, manages],
  );

  // The dialog shows the category as the list has it now, so it follows renames and closings.
  const optionsCategory = optionsOf && (categories.data?.find((c) => c.id === optionsOf.id) ?? optionsOf);

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{t('workerCategories.hint')}</p>
      <DataTable
        columns={columns}
        data={categories.data}
        isLoading={categories.isPending}
        isError={categories.isError}
        onRetry={() => categories.refetch()}
        totalCount={categories.data?.length}
        searchable
        searchText={(c) => [c.name, ...c.options.map((o) => o.name)].join(' ')}
        emptyTitle={t('workerCategories.empty')}
        emptyDescription={t('workerCategories.emptyDescription')}
      />
      {creating && (
        <CreateDialog
          onClose={() => onCreatingChange(false)}
          onSaved={async () => {
            onCreatingChange(false);
            toast.success(t('common.saved'));
            await refresh();
          }}
        />
      )}
      {renaming && (
        <RenameDialog
          category={renaming}
          onClose={() => setRenaming(null)}
          onSaved={async () => {
            setRenaming(null);
            toast.success(t('common.saved'));
            await refresh();
          }}
        />
      )}
      {optionsCategory && (
        <OptionsDialog
          category={optionsCategory}
          onClose={() => setOptionsOf(null)}
          onToggle={(option) => setToggling({ category: optionsCategory, option })}
          onSaved={async () => {
            toast.success(t('common.saved'));
            await refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={toggling !== null}
        onOpenChange={(open) => !open && setToggling(null)}
        title={toggleTitle(t, toggling)}
        description={toggling ? toggleDescription(t, toggling) : ''}
        confirmLabel={(toggling?.option ?? toggling?.category)?.isActive ? t('workerCategories.close') : t('workerCategories.reopen')}
        destructive={(toggling?.option ?? toggling?.category)?.isActive}
        onConfirm={async () => {
          if (!toggling) return;
          const { category, option } = toggling;
          if (option) await api.patch(`/worker-categories/${category.id}/options/${option.id}`, { isActive: !option.isActive });
          else await api.patch(`/worker-categories/${category.id}`, { isActive: !category.isActive });
          toast.success(t('common.saved'));
          await refresh();
        }}
      />
    </div>
  );
}

type T = ReturnType<typeof useTranslation>['t'];

function toggleTitle(t: T, toggling: Toggling | null) {
  const active = (toggling?.option ?? toggling?.category)?.isActive;
  if (toggling?.option) return active ? t('workerCategories.confirmCloseOption.title') : t('workerCategories.confirmReopenOption.title');
  return active ? t('workerCategories.confirmClose.title') : t('workerCategories.confirmReopen.title');
}

function toggleDescription(t: T, { category, option }: Toggling) {
  if (option) {
    const values = { name: option.name, category: category.name };
    return option.isActive
      ? t('workerCategories.confirmCloseOption.description', values)
      : t('workerCategories.confirmReopenOption.description', values);
  }
  return category.isActive
    ? t('workerCategories.confirmClose.description', { name: category.name })
    : t('workerCategories.confirmReopen.description', { name: category.name });
}

/** Adds a category with its options (two at least). */
function CreateDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [formError, setFormError] = useState<string>();
  const form = useForm<WorkerCategoryInput, unknown, WorkerCategory>({
    resolver: zodResolver(workerCategorySchema),
    defaultValues: { name: '', options: ['', ''] },
  });
  const { errors } = form.formState;

  const save = useMutation({
    mutationFn: (values: WorkerCategory) => api.post('/worker-categories', values),
    onSuccess: onSaved,
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('workerCategories.create')}</DialogTitle>
          <DialogDescription>{t('workerCategories.dialogDescription')}</DialogDescription>
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
          <Field id="wc-name" label={t('workerCategories.name')} error={errors.name} hint={t('workerCategories.nameHint')}>
            <Input {...fieldControlProps('wc-name', errors.name)} {...form.register('name')} autoComplete="off" />
          </Field>
          <Controller
            control={form.control}
            name="options"
            render={({ field }) => {
              const options = field.value ?? [];
              const listError = errors.options?.root ?? (errors.options as FieldError | undefined);
              return (
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">{t('workerCategories.options')}</legend>
                  {options.map((value, i) => {
                    const id = `wc-option-${i}`;
                    const error = errors.options?.[i];
                    return (
                      <div key={i} className="flex items-start gap-2">
                        <div className="flex-1">
                          <Field id={id} label={t('workerCategories.optionNumber', { number: i + 1 })} error={error}>
                            <Input
                              {...fieldControlProps(id, error)}
                              value={value}
                              onChange={(e) => field.onChange(options.map((o, j) => (j === i ? e.target.value : o)))}
                              autoComplete="off"
                            />
                          </Field>
                        </div>
                        {options.length > 2 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="mt-7"
                            aria-label={t('workerCategories.removeOption', { number: i + 1 })}
                            onClick={() => field.onChange(options.filter((_, j) => j !== i))}
                          >
                            <X aria-hidden />
                          </Button>
                        )}
                      </div>
                    );
                  })}
                  {listError?.message && (
                    <p role="alert" className="text-sm text-destructive">
                      {t(listError.message)}
                    </p>
                  )}
                  <Button type="button" variant="outline" onClick={() => field.onChange([...options, ''])}>
                    <Plus aria-hidden />
                    {t('workerCategories.addOption')}
                  </Button>
                </fieldset>
              );
            }}
          />
          <FormActions submitLabel={t('workerCategories.create')} pending={save.isPending} onCancel={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Renames a category. */
function RenameDialog({ category, onClose, onSaved }: { category: WorkerCategoryItem; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [formError, setFormError] = useState<string>();
  const form = useForm<UpdateWorkerCategory, unknown, UpdateWorkerCategory>({
    resolver: zodResolver(updateWorkerCategorySchema),
    defaultValues: { name: category.name },
  });
  const { errors } = form.formState;

  const save = useMutation({
    mutationFn: (values: UpdateWorkerCategory) => api.patch(`/worker-categories/${category.id}`, values),
    onSuccess: onSaved,
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('workerCategories.rename')}</DialogTitle>
          <DialogDescription>{category.name}</DialogDescription>
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
          <Field id="wc-rename" label={t('workerCategories.name')} error={errors.name}>
            <Input {...fieldControlProps('wc-rename', errors.name)} {...form.register('name')} autoComplete="off" />
          </Field>
          <FormActions submitLabel={t('common.save')} pending={save.isPending} onCancel={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A category's options: rename, close or reopen each, and add new ones. */
function OptionsDialog({
  category,
  onClose,
  onToggle,
  onSaved,
}: {
  category: WorkerCategoryItem;
  onClose: () => void;
  onToggle: (option: OptionItem) => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState<OptionItem | null>(null);
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('workerCategories.manageOptions')}</DialogTitle>
          <DialogDescription>{t('workerCategories.optionsDescription', { name: category.name })}</DialogDescription>
        </DialogHeader>
        <ul className="divide-y divide-border">
          {category.options.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="flex-1 font-medium">{o.name}</span>
              {!o.isActive && <StatusBadge tone="neutral">{t('workerCategories.closed')}</StatusBadge>}
              <Button variant="ghost" size="sm" onClick={() => setRenaming(o)}>
                <Pencil aria-hidden />
                {t('workerCategories.rename')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onToggle(o)}>
                <Power aria-hidden />
                {o.isActive ? t('workerCategories.close') : t('workerCategories.reopen')}
              </Button>
            </li>
          ))}
        </ul>
        {renaming ? (
          <OptionForm
            key={renaming.id}
            category={category}
            option={renaming}
            onDone={async () => {
              setRenaming(null);
              await onSaved();
            }}
            onCancel={() => setRenaming(null)}
          />
        ) : (
          <OptionForm key="new" category={category} option={null} onDone={onSaved} onCancel={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Adds an option to a category, or renames one. */
function OptionForm({
  category,
  option,
  onDone,
  onCancel,
}: {
  category: WorkerCategoryItem;
  option: OptionItem | null;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [formError, setFormError] = useState<string>();
  const form = useForm<CategoryOptionInput, unknown, CategoryOption>({
    resolver: zodResolver(categoryOptionSchema),
    defaultValues: { name: option?.name ?? '' },
  });
  const { errors } = form.formState;

  const save = useMutation({
    mutationFn: (values: CategoryOption) =>
      option
        ? api.patch(`/worker-categories/${category.id}/options/${option.id}`, values)
        : api.post(`/worker-categories/${category.id}/options`, values),
    onSuccess: async () => {
      form.reset({ name: '' });
      await onDone();
    },
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={form.handleSubmit((values) => {
        setFormError(undefined);
        save.mutate(values);
      })}
    >
      <FormError message={formError} />
      <Field id="wc-option" label={option ? t('workerCategories.renameOption', { name: option.name }) : t('workerCategories.newOption')} error={errors.name}>
        <Input {...fieldControlProps('wc-option', errors.name)} {...form.register('name')} autoComplete="off" />
      </Field>
      <FormActions
        submitLabel={option ? t('common.save') : t('workerCategories.addOption')}
        pending={save.isPending}
        onCancel={onCancel}
      />
    </form>
  );
}
