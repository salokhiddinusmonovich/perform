import { zodResolver } from '@hookform/resolvers/zod';
import { createMemberSchema, type CreateMemberInput, type Role } from '@puantaj/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { KeyRound, MoreHorizontal, Pencil, Power, UserPlus } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable } from '@/components/data-table';
import { Field, fieldControlProps, FormActions, FormError } from '@/components/form';
import { PageHeader } from '@/components/page-header';
import { RequireAccess } from '@/components/require-access';
import { RoleSelect, useRoleHint } from '@/components/role-select';
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
import { useFormat } from '@/hooks/use-format';
import { api } from '@/lib/api';
import { canManageCompany, useMe, type Me } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';

interface Member {
  userId: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  role: Role;
  isActive: boolean;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
}

type ConfirmAction = 'deactivate' | 'activate' | 'reset';

const MEMBERS_KEY = ['company', 'members'] as const;

const describe = (m: { fullName: string; phone?: string | null; email?: string | null }) =>
  `${m.fullName} (${m.phone || m.email})`;

export function UsersPage() {
  const { t } = useTranslation();
  const me = useMe().data;
  const [adding, setAdding] = useState(false);

  return (
    <>
      <PageHeader
        title={t('users.title')}
        description={t('users.description')}
        actions={
          canManageCompany(me) && (
            <Button onClick={() => setAdding(true)}>
              <UserPlus aria-hidden />
              {t('users.add')}
            </Button>
          )
        }
      />
      <RequireAccess allowed={canManageCompany}>
        {(verified) => <UsersView me={verified} adding={adding} onAddingChange={setAdding} />}
      </RequireAccess>
    </>
  );
}

function UsersView({
  me,
  adding,
  onAddingChange,
}: {
  me: Me;
  adding: boolean;
  onAddingChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const queryClient = useQueryClient();
  const myRole = me.activeCompany!.role; // guaranteed by canManageCompany
  const members = useQuery({ queryKey: MEMBERS_KEY, queryFn: () => api.get<Member[]>('/company/members') });

  const [editing, setEditing] = useState<Member | null>(null);
  const [confirm, setConfirm] = useState<{ member: Member; action: ConfirmAction } | null>(null);
  const [tempPassword, setTempPassword] = useState<{ password: string; forWhom: string } | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: MEMBERS_KEY });

  // Admins can't manage owners and nobody manages themselves (the API enforces both).
  const canManage = useCallback(
    (m: Member) => m.userId !== me.user.id && (m.role !== 'OWNER' || myRole === 'OWNER'),
    [me.user.id, myRole],
  );

  async function runConfirmed() {
    if (!confirm) return;
    const { member, action } = confirm;
    if (action === 'reset') {
      const res = await api.post<{ temporaryPassword: string }>(`/company/members/${member.userId}/reset-password`);
      setTempPassword({ password: res.temporaryPassword, forWhom: describe(member) });
    } else {
      await api.patch(`/company/members/${member.userId}`, { isActive: action === 'activate' });
      toast.success(t('common.saved'));
    }
    await refresh();
  }

  const columns = useMemo<ColumnDef<Member, unknown>[]>(
    () => [
      {
        accessorKey: 'fullName',
        header: t('users.name'),
        cell: ({ row }) => (
          <div className="min-w-40">
            <div className="font-medium">{row.original.fullName}</div>
            <div className="text-sm text-muted-foreground">
              {[row.original.phone, row.original.email].filter(Boolean).join(' · ')}
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'role',
        header: t('users.role'),
        cell: ({ row }) => t(`roles.${row.original.role}`),
      },
      {
        accessorKey: 'isActive',
        header: t('users.status'),
        cell: ({ row }) =>
          !row.original.isActive ? (
            <StatusBadge tone="neutral">{t('users.inactive')}</StatusBadge>
          ) : row.original.mustChangePassword ? (
            <StatusBadge tone="warning">{t('users.awaitingFirstLogin')}</StatusBadge>
          ) : (
            <StatusBadge tone="success">{t('users.active')}</StatusBadge>
          ),
      },
      {
        accessorKey: 'lastLoginAt',
        header: t('users.lastLogin'),
        cell: ({ row }) => (row.original.lastLoginAt ? format.date(row.original.lastLoginAt) : '—'),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{t('common.actions')}</span>,
        enableSorting: false,
        cell: ({ row }) =>
          canManage(row.original) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={t('common.actionsFor', { name: row.original.fullName })}>
                  <MoreHorizontal aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setEditing(row.original)}>
                  <Pencil aria-hidden />
                  {t('users.changeRole')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setConfirm({ member: row.original, action: 'reset' })}>
                  <KeyRound aria-hidden />
                  {t('users.resetPassword')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    setConfirm({ member: row.original, action: row.original.isActive ? 'deactivate' : 'activate' })
                  }
                >
                  <Power aria-hidden />
                  {row.original.isActive ? t('users.deactivate') : t('users.activate')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ),
      },
    ],
    [t, format, canManage],
  );

  return (
    <>
      <DataTable
        columns={columns}
        data={members.data}
        isLoading={members.isPending}
        isError={members.isError}
        onRetry={() => members.refetch()}
        searchable
        searchText={(m) => [m.fullName, m.phone, m.email, t(`roles.${m.role}`)].filter(Boolean).join(' ')}
      />

      <AddMemberDialog
        open={adding}
        myRole={myRole}
        onClose={() => onAddingChange(false)}
        onAdded={async (result, values) => {
          onAddingChange(false);
          await refresh();
          if (result.temporaryPassword) {
            setTempPassword({ password: result.temporaryPassword, forWhom: describe(values) });
          } else {
            toast.success(t('users.addedExisting'));
          }
        }}
      />
      <ChangeRoleDialog
        member={editing}
        myRole={myRole}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          toast.success(t('common.saved'));
          await refresh();
        }}
      />
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm ? t(`users.confirm.${confirm.action}.title`) : ''}
        description={confirm ? t(`users.confirm.${confirm.action}.description`, { name: describe(confirm.member) }) : ''}
        confirmLabel={confirm ? t(`users.confirm.${confirm.action}.button`) : ''}
        destructive={confirm?.action !== 'activate'}
        onConfirm={runConfirmed}
      />
      <TemporaryPasswordDialog
        password={tempPassword?.password ?? null}
        forWhom={tempPassword?.forWhom ?? ''}
        onClose={() => setTempPassword(null)}
      />
    </>
  );
}

function AddMemberDialog({
  open,
  myRole,
  onClose,
  onAdded,
}: {
  open: boolean;
  myRole: Role;
  onClose: () => void;
  onAdded: (result: { temporaryPassword: string | null }, values: CreateMemberInput) => void;
}) {
  const { t } = useTranslation();
  const roleHint = useRoleHint();
  const [formError, setFormError] = useState<string>();
  const form = useForm<CreateMemberInput>({
    resolver: zodResolver(createMemberSchema),
    defaultValues: { fullName: '', phone: '', email: '', role: undefined },
  });
  const { errors } = form.formState;

  const close = () => {
    form.reset();
    setFormError(undefined);
    onClose();
  };

  const create = useMutation({
    mutationFn: (values: CreateMemberInput) => api.post<{ temporaryPassword: string | null }>('/company/members', values),
    onSuccess: (result, values) => {
      form.reset();
      onAdded(result, values);
    },
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !create.isPending && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('users.add')}</DialogTitle>
          <DialogDescription>{t('users.addDescription')}</DialogDescription>
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
          <Field id="m-name" label={t('users.name')} error={errors.fullName}>
            <Input {...fieldControlProps('m-name', errors.fullName)} {...form.register('fullName')} autoComplete="off" />
          </Field>
          <Field id="m-phone" label={t('users.phone')} error={errors.phone} hint={t('users.phoneHint')}>
            <Input
              {...fieldControlProps('m-phone', errors.phone)}
              {...form.register('phone')}
              type="tel"
              inputMode="tel"
              placeholder="+998 90 123 45 67"
              autoComplete="off"
            />
          </Field>
          <Field id="m-email" label={t('users.email')} error={errors.email}>
            <Input
              {...fieldControlProps('m-email', errors.email)}
              {...form.register('email')}
              type="email"
              inputMode="email"
              autoComplete="off"
            />
          </Field>
          <Controller
            control={form.control}
            name="role"
            render={({ field }) => (
              <Field id="m-role" label={t('users.role')} error={errors.role} hint={roleHint(field.value)}>
                <RoleSelect
                  id="m-role"
                  value={field.value}
                  onChange={field.onChange}
                  disabledRoles={myRole === 'OWNER' ? [] : ['OWNER']}
                  invalid={!!errors.role}
                />
              </Field>
            )}
          />
          <FormActions submitLabel={t('users.add')} pending={create.isPending} onCancel={close} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ChangeRoleDialog({
  member,
  myRole,
  onClose,
  onSaved,
}: {
  member: Member | null;
  myRole: Role;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const roleHint = useRoleHint();
  const [role, setRole] = useState<Role | undefined>();
  const [formError, setFormError] = useState<string>();
  const current = role ?? member?.role;

  const close = () => {
    setRole(undefined);
    setFormError(undefined);
    onClose();
  };

  const save = useMutation({
    mutationFn: (userId: string) => api.patch(`/company/members/${userId}`, { role: current }),
    onSuccess: () => {
      setRole(undefined);
      onSaved();
    },
    onError: (error) => setFormError(errorMessage(t, error)),
  });

  return (
    <Dialog open={member !== null} onOpenChange={(open) => !open && !save.isPending && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('users.changeRole')}</DialogTitle>
          <DialogDescription>{member?.fullName}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!member) return;
            setFormError(undefined);
            save.mutate(member.userId);
          }}
        >
          <FormError message={formError} />
          <Field id="r-role" label={t('users.role')} hint={roleHint(current)}>
            <RoleSelect id="r-role" value={current} onChange={setRole} disabledRoles={myRole === 'OWNER' ? [] : ['OWNER']} />
          </Field>
          <FormActions submitLabel={t('common.save')} pending={save.isPending} onCancel={close} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
