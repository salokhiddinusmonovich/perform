import { zodResolver } from '@hookform/resolvers/zod';
import { createCompanySchema, type CreateCompanyInput } from '@puantaj/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Building2, ClipboardList, MoreHorizontal, Power } from 'lucide-react';
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
import { TemporaryPasswordDialog } from '@/components/temporary-password-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { useFormat } from '@/hooks/use-format';
import { api } from '@/lib/api';
import { ME_KEY, useMe, type Me } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';

interface CompanyRow {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  isActive: boolean;
  timesheetModule: boolean;
  createdAt: string;
  memberCount: number;
  owners: { fullName: string; email: string | null; phone: string | null }[];
}

const COMPANIES_KEY = ['platform', 'companies'] as const;

type CompanyAction = 'activate' | 'deactivate' | 'timesheetOn' | 'timesheetOff';
const CHANGES: Record<CompanyAction, { isActive?: boolean; timesheetModule?: boolean }> = {
  activate: { isActive: true },
  deactivate: { isActive: false },
  timesheetOn: { timesheetModule: true },
  timesheetOff: { timesheetModule: false },
};
const isPlatformAdmin = (me: Me) => me.user.isPlatformAdmin;

export function PlatformCompaniesPage() {
  const { t } = useTranslation();
  const me = useMe().data;
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title={t('platform.title')}
        description={t('platform.description')}
        actions={
          me?.user.isPlatformAdmin && (
            <Button onClick={() => setCreating(true)}>
              <Building2 aria-hidden />
              {t('platform.create')}
            </Button>
          )
        }
      />
      <RequireAccess allowed={isPlatformAdmin}>
        {() => <CompaniesView creating={creating} onCreatingChange={setCreating} />}
      </RequireAccess>
    </>
  );
}

function CompaniesView({ creating, onCreatingChange }: { creating: boolean; onCreatingChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const format = useFormat();
  const queryClient = useQueryClient();
  const companies = useQuery({ queryKey: COMPANIES_KEY, queryFn: () => api.get<CompanyRow[]>('/platform/companies') });
  const [confirm, setConfirm] = useState<{ company: CompanyRow; action: CompanyAction } | null>(null);
  const [tempPassword, setTempPassword] = useState<{ password: string; forWhom: string } | null>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: COMPANIES_KEY }),
      // The admin may own or join companies, which changes their company list.
      queryClient.invalidateQueries({ queryKey: ME_KEY }),
    ]);

  const columns = useMemo<ColumnDef<CompanyRow, unknown>[]>(
    () => [
      {
        accessorKey: 'name',
        header: t('platform.company'),
        cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      },
      {
        id: 'owners',
        header: t('platform.owner'),
        enableSorting: false,
        cell: ({ row }) =>
          row.original.owners.map((o) => (
            <div key={o.fullName + (o.phone ?? o.email)}>
              <div>{o.fullName}</div>
              <div className="text-sm text-muted-foreground">{o.phone ?? o.email}</div>
            </div>
          )),
      },
      { accessorKey: 'memberCount', header: t('platform.members') },
      {
        id: 'modules',
        header: t('platform.modules'),
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            <StatusBadge tone="info">{t('modules.PAYROLL')}</StatusBadge>
            {row.original.timesheetModule && <StatusBadge tone="info">{t('modules.TIMESHEET')}</StatusBadge>}
          </div>
        ),
      },
      {
        accessorKey: 'isActive',
        header: t('users.status'),
        cell: ({ row }) =>
          row.original.isActive ? (
            <StatusBadge tone="success">{t('users.active')}</StatusBadge>
          ) : (
            <StatusBadge tone="neutral">{t('users.inactive')}</StatusBadge>
          ),
      },
      {
        accessorKey: 'createdAt',
        header: t('platform.created'),
        cell: ({ row }) => format.date(row.original.createdAt),
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
              <DropdownMenuItem
                onSelect={() =>
                  setConfirm({ company: row.original, action: row.original.timesheetModule ? 'timesheetOff' : 'timesheetOn' })
                }
              >
                <ClipboardList aria-hidden />
                {row.original.timesheetModule ? t('platform.timesheetOff') : t('platform.timesheetOn')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setConfirm({ company: row.original, action: row.original.isActive ? 'deactivate' : 'activate' })}
              >
                <Power aria-hidden />
                {row.original.isActive ? t('platform.deactivate') : t('platform.activate')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [t, format],
  );

  return (
    <>
      <DataTable
        columns={columns}
        data={companies.data}
        isLoading={companies.isPending}
        isError={companies.isError}
        onRetry={() => companies.refetch()}
        searchable
        searchText={(c) => [c.name, ...c.owners.flatMap((o) => [o.fullName, o.phone, o.email])].filter(Boolean).join(' ')}
        emptyTitle={t('platform.empty')}
      />

      <CreateCompanyDialog
        open={creating}
        onClose={() => onCreatingChange(false)}
        onCreated={async (result, values) => {
          onCreatingChange(false);
          await refresh();
          if (result.temporaryPassword) {
            const contact = values.owner.phone || values.owner.email;
            setTempPassword({ password: result.temporaryPassword, forWhom: `${values.owner.fullName} (${contact})` });
          } else {
            toast.success(t('platform.createdExistingOwner'));
          }
        }}
      />
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm ? t(`platform.confirm.${confirm.action}.title`) : ''}
        description={confirm ? t(`platform.confirm.${confirm.action}.description`, { name: confirm.company.name }) : ''}
        confirmLabel={confirm ? t(`platform.confirm.${confirm.action}.button`) : ''}
        destructive={confirm?.action === 'deactivate' || confirm?.action === 'timesheetOff'}
        onConfirm={async () => {
          if (!confirm) return;
          await api.patch(`/platform/companies/${confirm.company.id}`, CHANGES[confirm.action]);
          toast.success(t('common.saved'));
          await refresh();
        }}
      />
      <TemporaryPasswordDialog
        password={tempPassword?.password ?? null}
        forWhom={tempPassword?.forWhom ?? ''}
        onClose={() => setTempPassword(null)}
      />
    </>
  );
}

function CreateCompanyDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (result: { temporaryPassword: string | null }, values: CreateCompanyInput) => void;
}) {
  const { t } = useTranslation();
  const [formError, setFormError] = useState<string>();
  const form = useForm<CreateCompanyInput>({
    resolver: zodResolver(createCompanySchema),
    defaultValues: {
      name: '',
      currency: 'UZS',
      timezone: 'Asia/Tashkent',
      owner: { fullName: '', phone: '', email: '' },
    },
  });
  const { errors } = form.formState;

  const close = () => {
    form.reset();
    setFormError(undefined);
    onClose();
  };

  const create = useMutation({
    mutationFn: (values: CreateCompanyInput) =>
      api.post<{ temporaryPassword: string | null }>('/platform/companies', values),
    onSuccess: (result, values) => {
      form.reset();
      onCreated(result, values);
    },
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !create.isPending && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('platform.create')}</DialogTitle>
          <DialogDescription>{t('platform.createDescription')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={form.handleSubmit((values) => {
            setFormError(undefined);
            create.mutate(values);
          })}
        >
          <FormError message={formError} />
          <Field id="c-name" label={t('company.name')} error={errors.name} hint={t('platform.currencyLater')}>
            <Input {...fieldControlProps('c-name', errors.name)} {...form.register('name')} autoComplete="off" />
          </Field>
          <Separator />
          <p className="text-sm font-medium">{t('platform.ownerSection')}</p>
          <Field id="c-owner-name" label={t('users.name')} error={errors.owner?.fullName}>
            <Input
              {...fieldControlProps('c-owner-name', errors.owner?.fullName)}
              {...form.register('owner.fullName')}
              autoComplete="off"
            />
          </Field>
          <Field id="c-owner-phone" label={t('users.phone')} error={errors.owner?.phone} hint={t('users.phoneHint')}>
            <Input
              {...fieldControlProps('c-owner-phone', errors.owner?.phone)}
              {...form.register('owner.phone')}
              type="tel"
              inputMode="tel"
              placeholder="+998 90 123 45 67"
              autoComplete="off"
            />
          </Field>
          <Field id="c-owner-email" label={t('users.email')} error={errors.owner?.email}>
            <Input
              {...fieldControlProps('c-owner-email', errors.owner?.email)}
              {...form.register('owner.email')}
              type="email"
              inputMode="email"
              autoComplete="off"
            />
          </Field>
          <FormActions submitLabel={t('platform.create')} pending={create.isPending} onCancel={close} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
