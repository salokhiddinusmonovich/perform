import { zodResolver } from '@hookform/resolvers/zod';
import {
  createWorkerSchema,
  EMPLOYMENT_TYPES,
  leaveSchema,
  placementDepartmentSchema,
  placementSchema,
  salarySchema,
  workerSchema,
  workerShiftSchema,
  workerShiftsSchema,
  type CreateWorker,
  type CreateWorkerInput,
  type Leave,
  type LeaveInput,
  type Placement,
  type PlacementDepartment,
  type PlacementDepartmentInput,
  type PlacementInput,
  type Salary,
  type SalaryInput,
  type Worker,
  type WorkerInput,
  type WorkerShift,
  type WorkerShiftInput,
  type WorkerShifts,
  type WorkerShiftsInput,
  type YearMonth,
} from '@puantaj/schemas';
import { useMutation } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowRightLeft, Building2, LogOut, MoreHorizontal, Pencil, SunMoon, Trash2, UserPlus, Wallet } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Controller, useForm, type Control, type FieldError, type FieldErrors, type FieldPath, type FieldValues } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable } from '@/components/data-table';
import { DatePicker } from '@/components/date-picker';
import {
  DepartmentFilter,
  DepartmentSelect,
  inDepartmentFilter,
  type DepartmentFilterValue,
} from '@/components/department-select';
import { ErrorState } from '@/components/error-state';
import { Field, fieldControlProps, FormActions, FormError, MonthField } from '@/components/form';
import { LoadingState } from '@/components/loading-state';
import { ALL_SITES, SiteFilter } from '@/components/list-filters';
import { PageHeader } from '@/components/page-header';
import { RequireAccess } from '@/components/require-access';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useFormat } from '@/hooks/use-format';
import { api } from '@/lib/api';
import {
  canAddSalaries,
  canAssignShifts,
  canManageCompany,
  canManageWorkers,
  inCompany,
  seesPay,
  seesPersonalData,
  useMe,
  usesDepartments,
  type Me,
} from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { today } from '@/lib/format';
import {
  departmentTree,
  useDepartments,
  useRefreshOrganisation,
  useSalaries,
  useShifts,
  useSites,
  useWorkers,
  useWorkerShifts,
  workerName,
  type DepartmentItem,
  type ShiftItem,
  type SiteItem,
  type WorkerItem,
  type WorkerShiftItem,
} from '@/lib/organisation';

type Status = 'working' | 'left' | 'all';
const ALL = 'all';

const hasLeft = (w: WorkerItem) => w.placement?.until != null && w.placement.until < today();

export function WorkersPage() {
  const { t } = useTranslation();
  const me = useMe().data;
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHeader
        title={t('workers.title')}
        description={t('workers.description')}
        actions={
          canManageWorkers(me) && (
            <Button onClick={() => setAdding(true)}>
              <UserPlus aria-hidden />
              {t('workers.add')}
            </Button>
          )
        }
      />
      <RequireAccess allowed={inCompany}>
        {(verified) => <WorkersView me={verified} adding={adding} onAddingChange={setAdding} />}
      </RequireAccess>
    </>
  );
}

type Action = { kind: 'edit' | 'move' | 'leave' | 'salary' | 'shift' | 'department'; worker: WorkerItem };

function WorkersView({ me, adding, onAddingChange }: { me: Me; adding: boolean; onAddingChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const format = useFormat();
  const workers = useWorkers();
  const sites = useSites();
  const departments = useDepartments();
  const refresh = useRefreshOrganisation();
  const showDepartments = usesDepartments(me);
  // The forms offer departments only while the company uses them.
  const departmentChoices = showDepartments ? (departments.data ?? []) : null;
  const paths = useMemo(
    () => new Map(departmentTree(departments.data ?? []).map((d) => [d.id, d.path])),
    [departments.data],
  );
  const manage = canManageWorkers(me);
  const personal = seesPersonalData(me);
  const pay = seesPay(me);
  const assignShifts = canAssignShifts(me);
  const currency = me.activeCompany!.currency;
  const [siteFilter, setSiteFilter] = useState(ALL_SITES);
  const [status, setStatus] = useState<Status>('working');
  const [departmentFilter, setDepartmentFilter] = useState<DepartmentFilterValue>(ALL);
  const [action, setAction] = useState<Action | null>(null);
  const [settingShifts, setSettingShifts] = useState(false);

  const rows = useMemo(
    () =>
      workers.data?.filter(
        (w) =>
          (siteFilter === ALL_SITES || w.placement?.siteId === siteFilter) &&
          (!showDepartments || inDepartmentFilter(departmentFilter, w.placement?.departmentId, departments.data ?? [])) &&
          (status === 'all' || (status === 'left') === hasLeft(w)),
      ),
    [workers.data, siteFilter, status, showDepartments, departmentFilter, departments.data],
  );

  const columns = useMemo<ColumnDef<WorkerItem, unknown>[]>(
    () => [
      {
        id: 'name',
        accessorFn: (w) => workerName(w),
        header: t('workers.name'),
        cell: ({ row }) => (
          <div className="min-w-44">
            <div className="font-medium">{workerName(row.original)}</div>
            {(row.original.employeeNumber || row.original.position) && (
              <div className="text-sm text-muted-foreground">
                {[
                  row.original.employeeNumber && t('workers.employeeNumberShort', { number: row.original.employeeNumber }),
                  row.original.position,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            )}
          </div>
        ),
      },
      {
        id: 'site',
        accessorFn: (w) => w.placement?.siteName ?? '',
        header: t('workers.site'),
        cell: ({ row }) => {
          const p = row.original.placement;
          return p ? (
            <div className="min-w-32">
              <div>{p.siteName}</div>
              {p.teamName && <div className="text-sm text-muted-foreground">{p.teamName}</div>}
            </div>
          ) : (
            '—'
          );
        },
      },
      ...(showDepartments
        ? [
            {
              id: 'department',
              accessorFn: (w) => (w.placement?.departmentId ? (paths.get(w.placement.departmentId) ?? '') : ''),
              header: t('departments.department'),
              cell: ({ row }) => {
                const p = row.original.placement;
                if (p?.departmentId) return <div className="min-w-32">{paths.get(p.departmentId) ?? p.departmentName}</div>;
                return hasLeft(row.original) ? '—' : <StatusBadge tone="warning">{t('departments.none')}</StatusBadge>;
              },
            } satisfies ColumnDef<WorkerItem, unknown>,
          ]
        : []),
      {
        id: 'shift',
        accessorFn: (w) => w.shift?.name ?? '',
        header: t('workers.shift'),
        cell: ({ row }) => <ShiftLabel shift={row.original.shift} />,
      },
      {
        id: 'from',
        accessorFn: (w) => w.placement?.from ?? '',
        header: t('workers.since'),
        cell: ({ row }) => (row.original.placement ? format.date(row.original.placement.from) : '—'),
      },
      ...(personal
        ? [
            {
              id: 'pinfl',
              header: t('workers.pinfl'),
              enableSorting: false,
              cell: ({ row }) => <span className="tabular-nums">{row.original.personal?.pinfl ?? '—'}</span>,
            } satisfies ColumnDef<WorkerItem, unknown>,
          ]
        : []),
      ...(pay
        ? [
            {
              id: 'salary',
              accessorFn: (w) => (w.salary ? Number(w.salary.monthlySalary) : -1),
              header: t('workers.salary'),
              cell: ({ row }) => {
                const s = row.original.salary;
                return s ? (
                  <div className="min-w-32 tabular-nums">
                    <div>{format.money(s.monthlySalary, currency)}</div>
                    <div className="text-sm text-muted-foreground">
                      {t('workers.salaryFrom', { month: format.month(s.fromYear, s.fromMonth) })}
                    </div>
                  </div>
                ) : (
                  <StatusBadge tone="warning">{t('workers.noSalary')}</StatusBadge>
                );
              },
            } satisfies ColumnDef<WorkerItem, unknown>,
          ]
        : []),
      {
        id: 'status',
        header: t('workers.status'),
        enableSorting: false,
        cell: ({ row }) => {
          const until = row.original.placement?.until;
          if (!until) return <StatusBadge tone="success">{t('workers.working')}</StatusBadge>;
          return hasLeft(row.original) ? (
            <StatusBadge tone="neutral">{t('workers.leftOn', { date: format.date(until) })}</StatusBadge>
          ) : (
            <StatusBadge tone="warning">{t('workers.leavesOn', { date: format.date(until) })}</StatusBadge>
          );
        },
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{t('common.actions')}</span>,
        enableSorting: false,
        cell: ({ row }) => (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={t('common.actionsFor', { name: workerName(row.original) })}>
                  <MoreHorizontal aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {manage && (
                  <>
                    <DropdownMenuItem onSelect={() => setAction({ kind: 'edit', worker: row.original })}>
                      <Pencil aria-hidden />
                      {t('workers.edit')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setAction({ kind: 'move', worker: row.original })}>
                      <ArrowRightLeft aria-hidden />
                      {hasLeft(row.original) ? t('workers.rehire') : t('workers.move')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setAction({ kind: 'leave', worker: row.original })}>
                      <LogOut aria-hidden />
                      {row.original.placement?.until ? t('workers.changeLastDay') : t('workers.leave')}
                    </DropdownMenuItem>
                    {showDepartments && row.original.placement && !row.original.placement.departmentId && (
                      <DropdownMenuItem onSelect={() => setAction({ kind: 'department', worker: row.original })}>
                        <Building2 aria-hidden />
                        {t('workers.setDepartment')}
                      </DropdownMenuItem>
                    )}
                  </>
                )}
                {pay && (
                  <DropdownMenuItem onSelect={() => setAction({ kind: 'salary', worker: row.original })}>
                    <Wallet aria-hidden />
                    {t('workers.salaryAction')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => setAction({ kind: 'shift', worker: row.original })}>
                  <SunMoon aria-hidden />
                  {t('workers.shiftAction')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ),
      },
    ],
    [t, format, manage, personal, pay, currency, showDepartments, paths],
  );

  const activeSites = (sites.data ?? []).filter((s) => s.isActive);
  const done = async () => {
    setAction(null);
    onAddingChange(false);
    toast.success(t('common.saved'));
    await refresh();
  };

  return (
    <>
      <DataTable
        columns={columns}
        data={rows}
        isLoading={workers.isPending}
        isError={workers.isError}
        onRetry={() => workers.refetch()}
        searchable
        searchText={(w) =>
          [
            workerName(w),
            w.employeeNumber,
            w.position,
            w.personal?.pinfl,
            w.placement?.siteName,
            w.placement?.teamName,
            showDepartments && w.placement?.departmentId ? paths.get(w.placement.departmentId) : null,
            w.shift?.name,
          ]
            .filter(Boolean)
            .join(' ')
        }
        toolbar={
          <>
            <SiteFilter
              sites={(sites.data ?? []).map((s) => ({ value: s.id, name: s.name }))}
              value={siteFilter}
              onChange={setSiteFilter}
            />
            {showDepartments && (
              <DepartmentFilter departments={departments.data ?? []} value={departmentFilter} onChange={setDepartmentFilter} />
            )}
            <Select value={status} onValueChange={(v) => setStatus(v as Status)}>
              <SelectTrigger className="w-full sm:w-40" aria-label={t('workers.status')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="working">{t('workers.filterWorking')}</SelectItem>
                <SelectItem value="left">{t('workers.filterLeft')}</SelectItem>
                <SelectItem value="all">{t('workers.filterAll')}</SelectItem>
              </SelectContent>
            </Select>
            {assignShifts && (
              <Button variant="outline" onClick={() => setSettingShifts(true)} disabled={!rows?.length}>
                <SunMoon aria-hidden />
                {t('workers.setShift')}
              </Button>
            )}
          </>
        }
        emptyTitle={t('workers.emptyTitle')}
        emptyDescription={manage ? t('workers.emptyDescription') : undefined}
      />

      {adding && (
        <AddWorkerDialog sites={activeSites} departments={departmentChoices} onClose={() => onAddingChange(false)} onSaved={done} />
      )}
      {action?.kind === 'edit' && (
        <EditWorkerDialog worker={action.worker} personal={personal} onClose={() => setAction(null)} onSaved={done} />
      )}
      {action?.kind === 'move' && (
        <MoveDialog
          worker={action.worker}
          sites={activeSites}
          departments={departmentChoices}
          onClose={() => setAction(null)}
          onSaved={done}
        />
      )}
      {action?.kind === 'leave' && <LeaveDialog worker={action.worker} onClose={() => setAction(null)} onSaved={done} />}
      {action?.kind === 'department' && (
        <PlacementDepartmentDialog
          worker={action.worker}
          departments={departments.data ?? []}
          onClose={() => setAction(null)}
          onSaved={done}
        />
      )}
      {action?.kind === 'shift' && (
        <WorkerShiftDialog
          worker={action.worker}
          canAdd={assignShifts}
          canCorrect={canManageCompany(me)}
          onClose={() => setAction(null)}
          onSaved={refresh}
        />
      )}
      {settingShifts && rows && (
        <SetShiftDialog workers={rows.filter((w) => !hasLeft(w))} onClose={() => setSettingShifts(false)} onSaved={async () => {
          setSettingShifts(false);
          await refresh();
        }} />
      )}
      {action?.kind === 'salary' && (
        <SalaryDialog
          worker={action.worker}
          currency={currency}
          canAdd={canAddSalaries(me)}
          onClose={() => setAction(null)}
          onSaved={done}
        />
      )}
    </>
  );
}

/** Empty worker form. Employment type has no default: the person adding chooses. */
const EMPTY_WORKER = {
  employeeNumber: '',
  lastName: '',
  firstName: '',
  patronymic: '',
  position: '',
  employmentType: undefined,
  pinfl: '',
  birthDate: '',
  nationality: '',
  passportSeries: '',
  passportNumber: '',
  phone: '',
};

function toWorkerInput(w: WorkerItem): WorkerInput {
  return {
    employeeNumber: w.employeeNumber ?? '',
    lastName: w.lastName,
    firstName: w.firstName,
    patronymic: w.patronymic ?? '',
    position: w.position ?? '',
    employmentType: w.employmentType,
    pinfl: w.personal?.pinfl ?? '',
    birthDate: w.personal?.birthDate ?? '',
    nationality: w.personal?.nationality ?? '',
    passportSeries: w.personal?.passportSeries ?? '',
    passportNumber: w.personal?.passportNumber ?? '',
    phone: w.personal?.phone ?? '',
  };
}

function AddWorkerDialog({
  sites,
  departments,
  onClose,
  onSaved,
}: {
  sites: SiteItem[];
  departments: DepartmentItem[] | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [formError, setFormError] = useState<string>();
  const form = useForm<CreateWorkerInput, unknown, CreateWorker>({
    resolver: zodResolver(createWorkerSchema),
    defaultValues: {
      worker: EMPTY_WORKER,
      placement: { siteId: sites.length === 1 ? sites[0].id : '', teamId: '', departmentId: '', from: today() },
    },
  });

  const save = useMutation({
    mutationFn: (values: CreateWorker) => api.post('/workers', values),
    onSuccess: onSaved,
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('workers.add')}</DialogTitle>
          <DialogDescription>{t('workers.addDescription')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-6"
          noValidate
          onSubmit={form.handleSubmit((values) => {
            setFormError(undefined);
            save.mutate(values);
          })}
        >
          <FormError message={formError} />
          <WorkerFields control={form.control} prefix="worker." errors={form.formState.errors.worker} personal />
          <section className="space-y-4 border-t pt-4">
            <h3 className="font-semibold">{t('workers.placement')}</h3>
            <PlacementFields
              control={form.control}
              prefix="placement."
              errors={form.formState.errors.placement}
              sites={sites}
              departments={departments}
              fromLabel={t('workers.firstDay')}
            />
          </section>
          <FormActions submitLabel={t('workers.add')} pending={save.isPending} onCancel={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditWorkerDialog({
  worker,
  personal,
  onClose,
  onSaved,
}: {
  worker: WorkerItem;
  personal: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [formError, setFormError] = useState<string>();
  const form = useForm<WorkerInput, unknown, Worker>({
    resolver: zodResolver(workerSchema),
    defaultValues: toWorkerInput(worker),
  });

  const save = useMutation({
    mutationFn: (values: Worker) => api.patch(`/workers/${worker.id}`, values),
    onSuccess: onSaved,
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('workers.edit')}</DialogTitle>
          <DialogDescription>{workerName(worker)}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-6"
          noValidate
          onSubmit={form.handleSubmit((values) => {
            setFormError(undefined);
            save.mutate(values);
          })}
        >
          <FormError message={formError} />
          <WorkerFields control={form.control} prefix="" errors={form.formState.errors} personal={personal} />
          <FormActions submitLabel={t('common.save')} pending={save.isPending} onCancel={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MoveDialog({
  worker,
  sites,
  departments,
  onClose,
  onSaved,
}: {
  worker: WorkerItem;
  sites: SiteItem[];
  departments: DepartmentItem[] | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [formError, setFormError] = useState<string>();
  const form = useForm<PlacementInput, unknown, Placement>({
    resolver: zodResolver(placementSchema),
    defaultValues: {
      siteId: worker.placement?.siteId ?? '',
      teamId: worker.placement?.teamId ?? '',
      departmentId: worker.placement?.departmentId ?? '',
      from: today(),
    },
  });
  const rehire = hasLeft(worker);

  const save = useMutation({
    mutationFn: (values: Placement) => api.post(`/workers/${worker.id}/placements`, values),
    onSuccess: onSaved,
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{rehire ? t('workers.rehire') : t('workers.move')}</DialogTitle>
          <DialogDescription>
            {workerName(worker)} · {rehire ? t('workers.rehireHint') : t('workers.moveHint')}
          </DialogDescription>
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
          <PlacementFields
            control={form.control}
            prefix=""
            errors={form.formState.errors}
            sites={sites}
            departments={departments}
            fromLabel={t('workers.firstDayThere')}
          />
          <FormActions submitLabel={t('common.save')} pending={save.isPending} onCancel={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LeaveDialog({ worker, onClose, onSaved }: { worker: WorkerItem; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [formError, setFormError] = useState<string>();
  const form = useForm<LeaveInput, unknown, Leave>({
    resolver: zodResolver(leaveSchema),
    defaultValues: { date: worker.placement?.until ?? today() },
  });

  const save = useMutation({
    mutationFn: (values: Leave) => api.post(`/workers/${worker.id}/leave`, values),
    onSuccess: onSaved,
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{worker.placement?.until ? t('workers.changeLastDay') : t('workers.leave')}</DialogTitle>
          <DialogDescription>
            {workerName(worker)} · {t('workers.leaveHint')}
          </DialogDescription>
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
          <Controller
            control={form.control}
            name="date"
            render={({ field, fieldState }) => (
              <Field id="l-date" label={t('workers.lastDay')} error={fieldState.error}>
                <DatePicker id="l-date" value={field.value} onChange={field.onChange} invalid={!!fieldState.error} />
              </Field>
            )}
          />
          <FormActions submitLabel={t('common.save')} pending={save.isPending} onCancel={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Fills in the department of a worker's placement that has none (from before the company
 * used departments). A placement in a brigade takes the brigade's, set on its site page.
 */
function PlacementDepartmentDialog({
  worker,
  departments,
  onClose,
  onSaved,
}: {
  worker: WorkerItem;
  departments: DepartmentItem[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const placement = worker.placement!;
  const [formError, setFormError] = useState<string>();
  const form = useForm<PlacementDepartmentInput, unknown, PlacementDepartment>({
    resolver: zodResolver(placementDepartmentSchema),
    defaultValues: { departmentId: '' },
  });

  const save = useMutation({
    mutationFn: (values: PlacementDepartment) =>
      api.put(`/workers/${worker.id}/placements/${placement.id}/department`, values),
    onSuccess: onSaved,
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('workers.setDepartment')}</DialogTitle>
          <DialogDescription>
            {workerName(worker)} · {t('workers.setDepartmentHint')}
          </DialogDescription>
        </DialogHeader>
        {placement.teamId ? (
          <div className="space-y-4">
            <p className="text-sm">{t('workers.departmentFromTeam', { team: placement.teamName })}</p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button asChild>
                <Link to={`/sites/${placement.siteId}`}>{t('workers.openSite', { site: placement.siteName })}</Link>
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="space-y-4"
            noValidate
            onSubmit={form.handleSubmit((values) => {
              setFormError(undefined);
              save.mutate(values);
            })}
          >
            <FormError message={formError} />
            <Controller
              control={form.control}
              name="departmentId"
              render={({ field, fieldState }) => (
                <Field id="pd-department" label={t('departments.department')} error={fieldState.error}>
                  <DepartmentSelect
                    id="pd-department"
                    departments={departments}
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    invalid={!!fieldState.error}
                  />
                </Field>
              )}
            />
            <FormActions submitLabel={t('common.save')} pending={save.isPending} onCancel={onClose} />
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The month after the current one: a new salary usually starts there. */
function nextMonth(): YearMonth {
  const [year, month] = today().split('-').map(Number);
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

/** Salary history, and adding a salary from a month (salaries are never edited). */
function SalaryDialog({
  worker,
  currency,
  canAdd,
  onClose,
  onSaved,
}: {
  worker: WorkerItem;
  currency: string;
  canAdd: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const history = useSalaries(worker.id);
  const [formError, setFormError] = useState<string>();
  const [from, setFrom] = useState<YearMonth>(nextMonth);
  const form = useForm<SalaryInput, unknown, Salary>({
    resolver: zodResolver(salarySchema),
    defaultValues: { fromYear: from.year, fromMonth: from.month, monthlySalary: '', reason: '' },
  });
  const { errors } = form.formState;
  const corrects = history.data?.some((s) => !s.corrected && s.fromYear === from.year && s.fromMonth === from.month);

  const save = useMutation({
    mutationFn: (values: Salary) => api.post(`/workers/${worker.id}/salaries`, values),
    onSuccess: onSaved,
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  const chooseMonth = (month: YearMonth) => {
    setFrom(month);
    form.setValue('fromYear', month.year);
    form.setValue('fromMonth', month.month);
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('workers.salaryTitle')}</DialogTitle>
          <DialogDescription>
            {workerName(worker)} · {canAdd ? t('workers.salaryHint') : t('workers.salaryViewHint')}
          </DialogDescription>
        </DialogHeader>
        {canAdd && (
          <form
            className="space-y-4"
            noValidate
            onSubmit={form.handleSubmit((values) => {
              setFormError(undefined);
              save.mutate(values);
            })}
          >
            <FormError message={formError} />
            <MonthField
              legend={t('workers.salaryFromMonth')}
              value={from}
              onChange={chooseMonth}
              error={errors.fromYear ?? errors.fromMonth}
              hint={
                corrects && (
                  <StatusBadge tone="warning">
                    {t('workers.salaryCorrects', { month: format.month(from.year, from.month) })}
                  </StatusBadge>
                )
              }
            />
            <Field
              id="s-amount"
              label={t('workers.monthlySalary', { currency })}
              error={errors.monthlySalary}
              hint={t('workers.monthlySalaryHint')}
            >
              <Input
                {...fieldControlProps('s-amount', errors.monthlySalary)}
                {...form.register('monthlySalary')}
                inputMode="decimal"
                autoComplete="off"
              />
            </Field>
            <Field id="s-reason" label={t('workers.salaryReason')} error={errors.reason} hint={t('workers.salaryReasonHint')}>
              <Input {...fieldControlProps('s-reason', errors.reason)} {...form.register('reason')} autoComplete="off" />
            </Field>
            <FormActions submitLabel={t('workers.addSalary')} pending={save.isPending} onCancel={onClose} />
          </form>
        )}
        <section className={canAdd ? 'space-y-2 border-t pt-4' : 'space-y-2'}>
          <h3 className="text-sm font-medium">{t('workers.salaryHistory')}</h3>
          {history.isPending ? (
            <LoadingState />
          ) : history.isError ? (
            <ErrorState onRetry={() => history.refetch()} />
          ) : history.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('workers.noSalaryYet')}</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {history.data.map((s) => (
                <li key={s.id} className="flex flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={s.corrected ? 'text-muted-foreground line-through' : 'font-medium'}>
                      {t('workers.salaryFromAmount', {
                        month: format.month(s.fromYear, s.fromMonth),
                        amount: format.money(s.monthlySalary, currency),
                      })}
                    </span>
                    {s.corrected && <StatusBadge tone="neutral">{t('common.corrected')}</StatusBadge>}
                  </span>
                  {s.reason && <span className="text-muted-foreground">{s.reason}</span>}
                  <span className="text-muted-foreground">
                    {s.setBy.fullName} · {format.date(s.setAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}

// Fields shared by the add and edit forms. `prefix` places them in a nested form
// ("worker." in the add form); the casts tie the field names to that prefix.

function WorkerFields<T extends FieldValues>({
  control,
  prefix,
  errors,
  personal,
}: {
  control: Control<T>;
  prefix: '' | 'worker.';
  errors: FieldErrors<WorkerInput> | undefined;
  personal: boolean;
}) {
  const { t } = useTranslation();
  const name = (field: keyof WorkerInput) => `${prefix}${field}` as FieldPath<T>;
  const text = (field: keyof WorkerInput, label: string, extra: { hint?: string; inputMode?: 'numeric' | 'tel' } = {}) => (
    <Controller
      control={control}
      name={name(field)}
      render={({ field: f }) => {
        const id = `w-${field}`;
        const error = errors?.[field];
        return (
          <Field id={id} label={label} error={error} hint={extra.hint}>
            <Input
              {...fieldControlProps(id, error)}
              name={f.name}
              value={(f.value as string | null) ?? ''}
              onChange={f.onChange}
              onBlur={f.onBlur}
              ref={f.ref}
              inputMode={extra.inputMode}
              autoComplete="off"
            />
          </Field>
        );
      }}
    />
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        {text('lastName', t('workers.lastName'))}
        {text('firstName', t('workers.firstName'))}
        {text('patronymic', t('workers.patronymic'))}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {text('employeeNumber', t('workers.employeeNumber'), { hint: t('workers.employeeNumberHint') })}
        {text('position', t('workers.position'))}
        <Controller
          control={control}
          name={name('employmentType')}
          render={({ field }) => (
            <Field id="w-employmentType" label={t('workers.employmentType')} error={errors?.employmentType}>
              <Select value={(field.value as string | undefined) ?? ''} onValueChange={field.onChange}>
                <SelectTrigger id="w-employmentType" className="w-full" aria-invalid={errors?.employmentType ? true : undefined}>
                  <SelectValue placeholder={t('workers.chooseEmploymentType')} />
                </SelectTrigger>
                <SelectContent>
                  {EMPLOYMENT_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {t(`workers.employment.${type}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        />
      </div>
      {personal && (
        <section className="space-y-4 border-t pt-4">
          <div>
            <h3 className="font-semibold">{t('workers.personalData')}</h3>
            <p className="text-sm text-muted-foreground">{t('workers.personalDataHint')}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {text('pinfl', t('workers.pinfl'), { hint: t('workers.pinflHint'), inputMode: 'numeric' })}
            <Controller
              control={control}
              name={name('birthDate')}
              render={({ field }) => (
                <Field id="w-birthDate" label={t('workers.birthDate')} error={errors?.birthDate}>
                  <DatePicker
                    id="w-birthDate"
                    value={(field.value as string | null) ?? ''}
                    onChange={field.onChange}
                    invalid={!!errors?.birthDate}
                    defaultMonth="1990-01-01"
                  />
                </Field>
              )}
            />
            {text('passportSeries', t('workers.passportSeries'))}
            {text('passportNumber', t('workers.passportNumber'))}
            {text('nationality', t('workers.nationality'))}
            {text('phone', t('workers.phone'), { inputMode: 'tel' })}
          </div>
        </section>
      )}
    </div>
  );
}

function PlacementFields<T extends FieldValues>({
  control,
  prefix,
  errors,
  sites,
  departments,
  fromLabel,
}: {
  control: Control<T>;
  prefix: '' | 'placement.';
  errors: FieldErrors<PlacementInput> | undefined;
  sites: SiteItem[];
  /** The company's departments while it uses them; null: departments are off */
  departments: DepartmentItem[] | null;
  fromLabel: string;
}) {
  const { t } = useTranslation();
  const name = (field: keyof PlacementInput) => `${prefix}${field}` as FieldPath<T>;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Controller
        control={control}
        name={name('siteId')}
        render={({ field: site }) => (
          <>
            <Field id="p-site" label={t('workers.site')} error={errors?.siteId}>
              <Select value={(site.value as string) ?? ''} onValueChange={site.onChange}>
                <SelectTrigger id="p-site" className="w-full" aria-invalid={errors?.siteId ? true : undefined}>
                  <SelectValue placeholder={t('workers.chooseSite')} />
                </SelectTrigger>
                <SelectContent>
                  {sites.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Controller
              control={control}
              name={name('departmentId')}
              render={({ field: department }) => (
                <Controller
                  control={control}
                  name={name('teamId')}
                  render={({ field: team }) => {
                    const teams = sites.find((s) => s.id === site.value)?.teams.filter((x) => x.isActive) ?? [];
                    const chosen = teams.find((x) => x.id === team.value);
                    // A placement in a brigade takes the brigade's department.
                    const chooseTeam = (v: string) => {
                      team.onChange(v === NO_TEAM ? '' : v);
                      const next = teams.find((x) => x.id === v);
                      if (next) department.onChange(next.departmentId ?? '');
                    };
                    return (
                      <>
                        <Field id="p-team" label={t('workers.team')} error={errors?.teamId}>
                          <Select value={chosen ? chosen.id : NO_TEAM} onValueChange={chooseTeam} disabled={!site.value}>
                            <SelectTrigger id="p-team" className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NO_TEAM}>{t('workers.noTeam')}</SelectItem>
                              {teams.map((x) => (
                                <SelectItem key={x.id} value={x.id}>
                                  {x.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Field>
                        {departments && (
                          <Field
                            id="p-department"
                            label={t('departments.department')}
                            error={errors?.departmentId}
                            hint={chosen ? t('workers.departmentOfTeam') : undefined}
                          >
                            <DepartmentSelect
                              id="p-department"
                              departments={departments}
                              value={chosen ? (chosen.departmentId ?? '') : ((department.value as string | null) ?? '')}
                              onChange={department.onChange}
                              invalid={!!errors?.departmentId}
                              disabled={Boolean(chosen)}
                            />
                          </Field>
                        )}
                      </>
                    );
                  }}
                />
              )}
            />
          </>
        )}
      />
      <Controller
        control={control}
        name={name('from')}
        render={({ field }) => (
          <Field id="p-from" label={fromLabel} error={errors?.from}>
            <DatePicker id="p-from" value={(field.value as string) ?? ''} onChange={field.onChange} invalid={!!errors?.from} />
          </Field>
        )}
      />
    </div>
  );
}

/** Radix Select can't hold an empty value, so "no team" has its own. */
const NO_TEAM = 'none';

/** A worker's shift, or the pay rules' normal hours when they have none. */
function ShiftLabel({ shift }: { shift: WorkerItem['shift'] }) {
  const { t } = useTranslation();
  const format = useFormat();
  return shift ? (
    <span className="whitespace-nowrap">{t('workers.shiftWithHours', { name: shift.name, hours: format.number(shift.normalHoursPerDay) })}</span>
  ) : (
    <span className="text-muted-foreground">{t('workers.noShift')}</span>
  );
}

/** Radix Select can't hold an empty value, so "no shift" has its own. */
const NO_SHIFT = 'none';

/** The shift and its first day, for one worker or many. */
function ShiftFields<T extends FieldValues>({
  control,
  errors,
  shifts,
  keep,
}: {
  control: Control<T>;
  errors: FieldErrors<WorkerShiftInput>;
  shifts: ShiftItem[];
  /** A shift to offer although it is no longer active: the one a corrected row has */
  keep?: string | null;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const offered = shifts.filter((s) => s.isActive || s.id === keep);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Controller
        control={control}
        name={'shiftId' as FieldPath<T>}
        render={({ field }) => (
          <Field id="ws-shift" label={t('workers.shift')} error={errors.shiftId}>
            <Select value={(field.value as string | null) || NO_SHIFT} onValueChange={(v) => field.onChange(v === NO_SHIFT ? '' : v)}>
              <SelectTrigger id="ws-shift" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_SHIFT}>{t('workers.noShift')}</SelectItem>
                {offered.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {t('workers.shiftWithHours', { name: s.name, hours: format.number(s.normalHoursPerDay) })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
      />
      <Controller
        control={control}
        name={'from' as FieldPath<T>}
        render={({ field }) => (
          <Field id="ws-from" label={t('workers.shiftFrom')} error={errors.from}>
            <DatePicker id="ws-from" value={(field.value as string) ?? ''} onChange={field.onChange} invalid={!!errors.from} />
          </Field>
        )}
      />
    </div>
  );
}

type Translate = ReturnType<typeof useTranslation>['t'];

/** What a shift row says: from which day, which shift (or none). */
function shiftRowText(t: Translate, format: ReturnType<typeof useFormat>, row: WorkerShiftItem) {
  const shift = row.shift
    ? t('workers.shiftWithHours', { name: row.shift.name, hours: format.number(row.shift.normalHoursPerDay) })
    : t('workers.noShift');
  return t('workers.shiftFromDay', { date: format.date(row.from), shift });
}

/**
 * A worker's shifts, each from a day until the next: adding a newer one, and (owners and
 * admins) correcting or removing a row.
 */
function WorkerShiftDialog({
  worker,
  canAdd,
  canCorrect,
  onClose,
  onSaved,
}: {
  worker: WorkerItem;
  canAdd: boolean;
  canCorrect: boolean;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const history = useWorkerShifts(worker.id);
  const shifts = useShifts();
  const [formError, setFormError] = useState<string>();
  const [correcting, setCorrecting] = useState<WorkerShiftItem | null>(null);
  const [removing, setRemoving] = useState<WorkerShiftItem | null>(null);
  const empty: WorkerShiftInput = { shiftId: '', from: today() };
  const form = useForm<WorkerShiftInput, unknown, WorkerShift>({ resolver: zodResolver(workerShiftSchema), defaultValues: empty });

  const correct = (row: WorkerShiftItem | null) => {
    setCorrecting(row);
    setFormError(undefined);
    form.reset(row ? { shiftId: row.shift?.id ?? '', from: row.from } : empty);
  };

  const save = useMutation({
    mutationFn: async (values: WorkerShift) => {
      if (correcting) {
        await api.put(`/workers/${worker.id}/shifts/${correcting.id}`, values);
        return null;
      }
      return api.post<{ added: number; unchanged: number }>('/worker-shifts', { ...values, workerIds: [worker.id] });
    },
    onSuccess: async (result) => {
      if (result?.added === 0) toast.info(t('workers.shiftUnchanged'));
      else toast.success(t('common.saved'));
      correct(null);
      await onSaved();
    },
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('workers.shiftTitle')}</DialogTitle>
          <DialogDescription>
            {workerName(worker)} · {t('workers.shiftHint')}
          </DialogDescription>
        </DialogHeader>
        {(canAdd || correcting) && (
          <form
            className="space-y-4"
            noValidate
            onSubmit={form.handleSubmit((values) => {
              setFormError(undefined);
              save.mutate(values);
            })}
          >
            {correcting && (
              <StatusBadge tone="warning">{t('workers.shiftCorrecting', { row: shiftRowText(t, format, correcting) })}</StatusBadge>
            )}
            <FormError message={formError} />
            <ShiftFields control={form.control} errors={form.formState.errors} shifts={shifts.data ?? []} keep={correcting?.shift?.id} />
            <FormActions
              submitLabel={correcting ? t('common.save') : t('workers.addShift')}
              pending={save.isPending}
              onCancel={correcting ? () => correct(null) : onClose}
            />
          </form>
        )}
        <section className={canAdd || correcting ? 'space-y-2 border-t pt-4' : 'space-y-2'}>
          <h3 className="text-sm font-medium">{t('workers.shiftHistory')}</h3>
          {history.isPending ? (
            <LoadingState />
          ) : history.isError ? (
            <ErrorState onRetry={() => history.refetch()} />
          ) : history.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('workers.noShiftYet')}</p>
          ) : (
            <ul className="divide-y rounded-lg border text-sm">
              {history.data.map((row) => (
                <li key={row.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                  <div className="min-w-0">
                    <div className="font-medium">{shiftRowText(t, format, row)}</div>
                    <div className="text-muted-foreground">
                      {row.setBy.fullName} · {format.date(row.setAt)}
                    </div>
                  </div>
                  {canCorrect && (
                    <div className="flex shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => correct(row)}
                        aria-label={t('workers.correctShift', { row: shiftRowText(t, format, row) })}
                      >
                        <Pencil aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setRemoving(row)}
                        aria-label={t('workers.removeShift', { row: shiftRowText(t, format, row) })}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        <ConfirmDialog
          open={removing !== null}
          onOpenChange={(open) => !open && setRemoving(null)}
          title={t('workers.confirmRemoveShift.title')}
          description={
            removing ? t('workers.confirmRemoveShift.description', { name: workerName(worker), row: shiftRowText(t, format, removing) }) : ''
          }
          confirmLabel={t('workers.confirmRemoveShift.button')}
          destructive
          onConfirm={async () => {
            if (!removing) return;
            await api.delete(`/workers/${worker.id}/shifts/${removing.id}`);
            if (correcting?.id === removing.id) correct(null);
            toast.success(t('common.saved'));
            await onSaved();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/** The same shift from a day for many workers at once ("night shift from day X"). */
function SetShiftDialog({ workers, onClose, onSaved }: { workers: WorkerItem[]; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const { t } = useTranslation();
  const shifts = useShifts();
  const [formError, setFormError] = useState<string>();
  const form = useForm<WorkerShiftsInput, unknown, WorkerShifts>({
    resolver: zodResolver(workerShiftsSchema),
    defaultValues: { workerIds: [], shiftId: '', from: today() },
  });
  const { errors } = form.formState;

  const save = useMutation({
    mutationFn: (values: WorkerShifts) => api.post<{ added: number; unchanged: number }>('/worker-shifts', values),
    onSuccess: async ({ added, unchanged }) => {
      toast.success(unchanged > 0 ? t('workers.shiftsSetSome', { added, unchanged }) : t('workers.shiftsSet', { count: added }));
      await onSaved();
    },
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('workers.setShift')}</DialogTitle>
          <DialogDescription>{t('workers.setShiftHint')}</DialogDescription>
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
          <ShiftFields control={form.control} errors={errors} shifts={shifts.data ?? []} />
          <Controller
            control={form.control}
            name="workerIds"
            render={({ field }) => {
              const chosen = new Set(field.value);
              const all = workers.length > 0 && workers.every((w) => chosen.has(w.id));
              return (
                <Field id="ws-workers" label={t('workers.chooseWorkers', { count: chosen.size })} error={errors.workerIds?.root ?? (errors.workerIds as FieldError | undefined)}>
                  <div id="ws-workers" className="rounded-lg border">
                    <div className="flex min-h-10 items-center gap-3 border-b px-3">
                      <Checkbox id="ws-all" checked={all} onCheckedChange={(v) => field.onChange(v === true ? workers.map((w) => w.id) : [])} />
                      <Label htmlFor="ws-all">{t('workers.allShown')}</Label>
                    </div>
                    <ul className="max-h-64 overflow-y-auto">
                      {workers.map((w) => (
                        <li key={w.id} className="flex min-h-10 items-center gap-3 px-3">
                          <Checkbox
                            id={`ws-${w.id}`}
                            checked={chosen.has(w.id)}
                            onCheckedChange={(v) =>
                              field.onChange(v === true ? [...field.value, w.id] : field.value.filter((id) => id !== w.id))
                            }
                          />
                          <Label htmlFor={`ws-${w.id}`} className="flex min-w-0 flex-1 flex-wrap justify-between gap-x-2 font-normal">
                            <span className="truncate">{workerName(w)}</span>
                            <ShiftLabel shift={w.shift} />
                          </Label>
                        </li>
                      ))}
                    </ul>
                  </div>
                </Field>
              );
            }}
          />
          <FormActions submitLabel={t('workers.setShift')} pending={save.isPending} onCancel={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
