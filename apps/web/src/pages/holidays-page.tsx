import { zodResolver } from '@hookform/resolvers/zod';
import { HOLIDAY_KINDS, holidaySchema, type Holiday, type HolidayInput, type HolidayKind } from '@puantaj/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { CalendarPlus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable } from '@/components/data-table';
import { DatePicker } from '@/components/date-picker';
import { Field, fieldControlProps, FormActions, FormError } from '@/components/form';
import { MissingHolidaysAlert } from '@/components/missing-holidays-alert';
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
import { YearSwitcher } from '@/components/year-switcher';
import { useFormat } from '@/hooks/use-format';
import { api } from '@/lib/api';
import { canManageCompany, canViewPayRules, useMe, type Me } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { isoWeekday } from '@/lib/format';

interface EnteredHoliday {
  id: string;
  date: string;
  kind: HolidayKind;
  name: string | null;
}

interface HolidayYear {
  year: number;
  fixed: { date: string; key: string }[];
  entered: EnteredHoliday[];
  missingMovingHolidays: string[];
}

/** One row of the table: a built-in holiday (no id) or one the company entered. */
type Row = { date: string; fixedKey: string | null; holiday: EnteredHoliday | null };

const holidaysKey = (year: number) => ['holidays', year] as const;
const WORKING_DAYS_KEY = ['working-days'] as const;

export function HolidaysPage() {
  const { t } = useTranslation();
  const me = useMe().data;
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHeader
        title={t('holidays.title')}
        description={t('holidays.description')}
        actions={
          canManageCompany(me) && (
            <Button onClick={() => setAdding(true)}>
              <CalendarPlus aria-hidden />
              {t('holidays.add')}
            </Button>
          )
        }
      />
      <RequireAccess allowed={canViewPayRules}>
        {(verified) => (
          <HolidaysView me={verified} year={year} onYearChange={setYear} adding={adding} onAddingChange={setAdding} />
        )}
      </RequireAccess>
    </>
  );
}

function HolidaysView({
  me,
  year,
  onYearChange,
  adding,
  onAddingChange,
}: {
  me: Me;
  year: number;
  onYearChange: (year: number) => void;
  adding: boolean;
  onAddingChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const queryClient = useQueryClient();
  const canChange = canManageCompany(me);
  const holidays = useQuery({ queryKey: holidaysKey(year), queryFn: () => api.get<HolidayYear>(`/holidays?year=${year}`) });
  const [editing, setEditing] = useState<EnteredHoliday | null>(null);
  const [deleting, setDeleting] = useState<EnteredHoliday | null>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['holidays'] }),
      queryClient.invalidateQueries({ queryKey: WORKING_DAYS_KEY }),
    ]);

  const rows = useMemo<Row[] | undefined>(
    () =>
      holidays.data && [
        ...holidays.data.fixed.map((h) => ({ date: h.date, fixedKey: h.key, holiday: null })),
        ...holidays.data.entered.map((h) => ({ date: h.date, fixedKey: null, holiday: h })),
      ].sort((a, b) => a.date.localeCompare(b.date)),
    [holidays.data],
  );

  const describe = (h: EnteredHoliday) => `${format.date(h.date)} · ${t(`holidays.kind.${h.kind}`)}`;

  const columns = useMemo<ColumnDef<Row, unknown>[]>(
    () => [
      {
        accessorKey: 'date',
        header: t('holidays.date'),
        cell: ({ row }) => (
          <div className="min-w-28">
            <div className="font-medium">{format.date(row.original.date)}</div>
            <div className="text-sm text-muted-foreground">
              {format.weekday(isoWeekday(row.original.date))}
            </div>
          </div>
        ),
      },
      {
        id: 'name',
        header: t('holidays.name'),
        enableSorting: false,
        cell: ({ row }) => {
          const { holiday, fixedKey } = row.original;
          if (!holiday) return t(`holidays.fixed.${fixedKey}`);
          return (
            <div className="min-w-40">
              <div>{t(`holidays.kind.${holiday.kind}`)}</div>
              {holiday.name && <div className="text-sm text-muted-foreground">{holiday.name}</div>}
            </div>
          );
        },
      },
      {
        id: 'type',
        header: t('holidays.type'),
        enableSorting: false,
        cell: ({ row }) =>
          !row.original.holiday ? (
            <StatusBadge tone="neutral">{t('holidays.builtIn')}</StatusBadge>
          ) : row.original.holiday.kind === 'WORKING_DAY' ? (
            <StatusBadge tone="success">{t('holidays.workingDay')}</StatusBadge>
          ) : (
            <StatusBadge tone="info">{t('holidays.dayOff')}</StatusBadge>
          ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{t('common.actions')}</span>,
        enableSorting: false,
        cell: ({ row }) => {
          const holiday = row.original.holiday;
          if (!canChange || !holiday) return null;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={t('common.actionsFor', { name: format.date(holiday.date) })}>
                  <MoreHorizontal aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setEditing(holiday)}>
                  <Pencil aria-hidden />
                  {t('holidays.edit')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDeleting(holiday)}>
                  <Trash2 aria-hidden />
                  {t('holidays.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [t, format, canChange],
  );

  return (
    <>
      {holidays.data && <MissingHolidaysAlert year={year} missing={holidays.data.missingMovingHolidays} />}
      <DataTable
        columns={columns}
        data={rows}
        isLoading={holidays.isPending}
        isError={holidays.isError}
        onRetry={() => holidays.refetch()}
        toolbar={<YearSwitcher year={year} onChange={onYearChange} />}
        pageSize={50}
      />

      <HolidayDialog
        // A fresh form for each holiday opened
        key={editing?.id ?? 'new'}
        open={adding || editing !== null}
        holiday={editing}
        year={year}
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
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('holidays.confirmDelete.title')}
        description={deleting ? t('holidays.confirmDelete.description', { holiday: describe(deleting) }) : ''}
        confirmLabel={t('holidays.delete')}
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          await api.delete(`/holidays/${deleting.id}`);
          toast.success(t('common.saved'));
          await refresh();
        }}
      />
    </>
  );
}

function HolidayDialog({
  open,
  holiday,
  year,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** null = adding a new one */
  holiday: EnteredHoliday | null;
  year: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [formError, setFormError] = useState<string>();
  const form = useForm<HolidayInput, unknown, Holiday>({
    resolver: zodResolver(holidaySchema),
    defaultValues: holiday
      ? { date: holiday.date, kind: holiday.kind, name: holiday.name ?? '' }
      : { date: '', kind: undefined, name: '' },
  });
  const { errors } = form.formState;
  const kind = form.watch('kind');

  const close = () => {
    form.reset();
    setFormError(undefined);
    onClose();
  };

  const save = useMutation({
    mutationFn: (values: Holiday) =>
      holiday ? api.put(`/holidays/${holiday.id}`, values) : api.post('/holidays', values),
    onSuccess: () => {
      form.reset();
      setFormError(undefined);
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
          <DialogTitle>{holiday ? t('holidays.edit') : t('holidays.add')}</DialogTitle>
          <DialogDescription>{t('holidays.addDescription')}</DialogDescription>
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
            render={({ field }) => (
              <Field id="h-date" label={t('holidays.date')} error={errors.date}>
                <DatePicker
                  id="h-date"
                  value={field.value}
                  onChange={field.onChange}
                  invalid={!!errors.date}
                  defaultMonth={`${year}-01-01`}
                />
              </Field>
            )}
          />
          <Controller
            control={form.control}
            name="kind"
            render={({ field }) => (
              <Field
                id="h-kind"
                label={t('holidays.type')}
                error={errors.kind}
                hint={kind ? t(`holidays.kindHint.${kind}`) : undefined}
              >
                <Select value={field.value ?? ''} onValueChange={field.onChange}>
                  <SelectTrigger id="h-kind" className="w-full" aria-invalid={errors.kind ? true : undefined}>
                    <SelectValue placeholder={t('holidays.chooseKind')} />
                  </SelectTrigger>
                  <SelectContent>
                    {HOLIDAY_KINDS.map((k) => (
                      <SelectItem key={k} value={k}>
                        {t(`holidays.kind.${k}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          />
          <Field id="h-name" label={t('holidays.note')} error={errors.name} hint={t('holidays.noteHint')}>
            <Input {...fieldControlProps('h-name', errors.name)} {...form.register('name')} autoComplete="off" />
          </Field>
          <FormActions submitLabel={t('common.save')} pending={save.isPending} onCancel={close} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
