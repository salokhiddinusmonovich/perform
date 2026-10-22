import { zodResolver } from '@hookform/resolvers/zod';
import {
  createPlatformUserSchema,
  updatePlatformUserSchema,
  type CreatePlatformUserInput,
  type Role,
  type UpdatePlatformUserInput,
} from '@puantaj/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Building2, KeyRound, LogIn, MoreHorizontal, Pencil, Power, ShieldCheck, UserPlus } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Controller, useForm, type FieldError, type UseFormRegisterReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useFormat } from '@/hooks/use-format';
import { api } from '@/lib/api';
import { isPlatformAdmin, useMe, useResetSession, type Me } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { COMPANIES_KEY, useCompanies, USERS_KEY, type UserRow } from '@/lib/platform';

type ConfirmAction = 'deactivate' | 'activate' | 'reset' | 'impersonate' | 'grantAdmin' | 'revokeAdmin';

const describe = (u: { fullName: string; phone?: string | null; email?: string | null }) =>
  `${u.fullName} (${u.phone || u.email})`;

export function PlatformUsersPage() {
  const { t } = useTranslation();
  const me = useMe().data;
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title={t('platformUsers.title')}
        description={t('platformUsers.description')}
        actions={
          isPlatformAdmin(me) && (
            <Button onClick={() => setCreating(true)}>
              <UserPlus aria-hidden />
              {t('platformUsers.create')}
            </Button>
          )
        }
      />
      <RequireAccess allowed={isPlatformAdmin}>
        {(verified) => <UsersView me={verified} creating={creating} onCreatingChange={setCreating} />}
      </RequireAccess>
    </>
  );
}

function UsersView({ me, creating, onCreatingChange }: { me: Me; creating: boolean; onCreatingChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const format = useFormat();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const resetSession = useResetSession();
  const users = useQuery({ queryKey: USERS_KEY, queryFn: () => api.get<UserRow[]>('/platform/users') });
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [placing, setPlacing] = useState<UserRow | null>(null);
  const [confirm, setConfirm] = useState<{ user: UserRow; action: ConfirmAction } | null>(null);
  const [tempPassword, setTempPassword] = useState<{ password: string; forWhom: string } | null>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: USERS_KEY }),
      queryClient.invalidateQueries({ queryKey: COMPANIES_KEY }),
    ]);

  async function runConfirmed() {
    if (!confirm) return;
    const { user, action } = confirm;
    switch (action) {
      case 'reset': {
        const res = await api.post<{ temporaryPassword: string }>(`/platform/users/${user.id}/reset-password`);
        setTempPassword({ password: res.temporaryPassword, forWhom: describe(user) });
        break;
      }
      case 'impersonate':
        await api.post(`/platform/users/${user.id}/impersonate`);
        await resetSession();
        await navigate('/', { replace: true });
        return;
      default:
        await api.patch(
          `/platform/users/${user.id}`,
          action === 'grantAdmin' || action === 'revokeAdmin'
            ? { isPlatformAdmin: action === 'grantAdmin' }
            : { isActive: action === 'activate' },
        );
        toast.success(t('common.saved'));
    }
    await refresh();
  }

  const columns = useMemo<ColumnDef<UserRow, unknown>[]>(
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
        id: 'companies',
        header: t('platformUsers.companies'),
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex min-w-48 flex-col gap-1">
            {row.original.isPlatformAdmin && (
              <div>
                <StatusBadge tone="info">{t('platformUsers.platformAdmin')}</StatusBadge>
              </div>
            )}
            {row.original.memberships.map((m) => (
              <div key={m.companyId} className="text-sm">
                <span className="font-medium">{m.companyName}</span> · {t(`roles.${m.role}`)}
                {(!m.isActive || m.invitation) && (
                  <span className="text-muted-foreground">
                    {' '}
                    ({!m.isActive
                      ? t('users.inactive')
                      : m.invitation === 'pending'
                        ? t('users.invitationPending')
                        : t('users.invitationDeclined')})
                  </span>
                )}
              </div>
            ))}
            {!row.original.isPlatformAdmin && row.original.memberships.length === 0 && (
              <span className="text-sm text-muted-foreground">{t('platformUsers.noCompany')}</span>
            )}
          </div>
        ),
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
        cell: ({ row }) => {
          const user = row.original;
          const self = user.id === me.user.id;
          const ask = (action: ConfirmAction) => () => setConfirm({ user, action });
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={t('common.actionsFor', { name: user.fullName })}>
                  <MoreHorizontal aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setEditing(user)}>
                  <Pencil aria-hidden />
                  {t('platformUsers.edit')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setPlacing(user)}>
                  <Building2 aria-hidden />
                  {t('platformUsers.membership')}
                </DropdownMenuItem>
                {!self && (
                  <>
                    {/* Only active customers can be impersonated; the API refuses the rest. */}
                    {user.isActive && !user.isPlatformAdmin && (
                      <DropdownMenuItem onSelect={ask('impersonate')}>
                        <LogIn aria-hidden />
                        {t('platformUsers.impersonate')}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={ask('reset')}>
                      <KeyRound aria-hidden />
                      {t('users.resetPassword')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={ask(user.isPlatformAdmin ? 'revokeAdmin' : 'grantAdmin')}>
                      <ShieldCheck aria-hidden />
                      {user.isPlatformAdmin ? t('platformUsers.revokeAdmin') : t('platformUsers.grantAdmin')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={ask(user.isActive ? 'deactivate' : 'activate')}>
                      <Power aria-hidden />
                      {user.isActive ? t('users.deactivate') : t('users.activate')}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [t, format, me.user.id],
  );

  return (
    <>
      <DataTable
        columns={columns}
        data={users.data}
        isLoading={users.isPending}
        isError={users.isError}
        onRetry={() => users.refetch()}
        searchable
        searchText={(u) =>
          [u.fullName, u.phone, u.email, ...u.memberships.map((m) => m.companyName)].filter(Boolean).join(' ')
        }
      />

      <CreateUserDialog
        open={creating}
        onClose={() => onCreatingChange(false)}
        onCreated={async (result, values) => {
          onCreatingChange(false);
          await refresh();
          setTempPassword({ password: result.temporaryPassword, forWhom: describe(values) });
        }}
      />
      <EditUserDialog
        user={editing}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          toast.success(t('common.saved'));
          await refresh();
        }}
      />
      <MembershipDialog
        user={placing}
        onClose={() => setPlacing(null)}
        onSaved={async () => {
          setPlacing(null);
          toast.success(t('common.saved'));
          await refresh();
        }}
      />
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm ? t(`platformUsers.confirm.${confirm.action}.title`) : ''}
        description={confirm ? t(`platformUsers.confirm.${confirm.action}.description`, { name: describe(confirm.user) }) : ''}
        confirmLabel={confirm ? t(`platformUsers.confirm.${confirm.action}.button`) : ''}
        destructive={confirm?.action === 'deactivate' || confirm?.action === 'reset' || confirm?.action === 'revokeAdmin'}
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

type ContactField = 'fullName' | 'phone' | 'email';

/** Name, phone and email fields, shared by the create and edit forms. */
function ContactFields({
  prefix,
  register,
  errors,
}: {
  prefix: string;
  register: (name: ContactField) => UseFormRegisterReturn;
  errors: Partial<Record<ContactField, FieldError>>;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Field id={`${prefix}-name`} label={t('users.name')} error={errors.fullName}>
        <Input {...fieldControlProps(`${prefix}-name`, errors.fullName)} {...register('fullName')} autoComplete="off" />
      </Field>
      <Field id={`${prefix}-phone`} label={t('users.phone')} error={errors.phone} hint={t('users.phoneHint')}>
        <Input
          {...fieldControlProps(`${prefix}-phone`, errors.phone)}
          {...register('phone')}
          type="tel"
          inputMode="tel"
          placeholder="+998 90 123 45 67"
          autoComplete="off"
        />
      </Field>
      <Field id={`${prefix}-email`} label={t('users.email')} error={errors.email}>
        <Input
          {...fieldControlProps(`${prefix}-email`, errors.email)}
          {...register('email')}
          type="email"
          inputMode="email"
          autoComplete="off"
        />
      </Field>
    </>
  );
}

function CreateUserDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (result: { temporaryPassword: string }, values: CreatePlatformUserInput) => void;
}) {
  const { t } = useTranslation();
  const [formError, setFormError] = useState<string>();
  const form = useForm<CreatePlatformUserInput>({
    resolver: zodResolver(createPlatformUserSchema),
    defaultValues: { fullName: '', phone: '', email: '', isPlatformAdmin: false },
  });

  const close = () => {
    form.reset();
    setFormError(undefined);
    onClose();
  };

  const create = useMutation({
    mutationFn: (values: CreatePlatformUserInput) => api.post<{ temporaryPassword: string }>('/platform/users', values),
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
          <DialogTitle>{t('platformUsers.create')}</DialogTitle>
          <DialogDescription>{t('platformUsers.createDescription')}</DialogDescription>
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
          <ContactFields prefix="pu" register={(name) => form.register(name)} errors={form.formState.errors} />
          <Controller
            control={form.control}
            name="isPlatformAdmin"
            render={({ field }) => (
              <div className="flex min-h-10 items-center gap-3">
                <Checkbox id="pu-admin" checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} />
                <Label htmlFor="pu-admin">{t('platformUsers.platformAdmin')}</Label>
              </div>
            )}
          />
          <FormActions submitLabel={t('platformUsers.create')} pending={create.isPending} onCancel={close} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditUserDialog({ user, onClose, onSaved }: { user: UserRow | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [formError, setFormError] = useState<string>();
  const form = useForm<UpdatePlatformUserInput>({
    resolver: zodResolver(updatePlatformUserSchema),
    values: { contact: { fullName: user?.fullName ?? '', phone: user?.phone ?? '', email: user?.email ?? '' } },
  });

  const close = () => {
    setFormError(undefined);
    onClose();
  };

  const save = useMutation({
    mutationFn: (values: UpdatePlatformUserInput) => api.patch(`/platform/users/${user!.id}`, values),
    onSuccess: onSaved,
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open={user !== null} onOpenChange={(open) => !open && !save.isPending && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('platformUsers.edit')}</DialogTitle>
          <DialogDescription>{t('platformUsers.editDescription')}</DialogDescription>
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
          <ContactFields
            prefix="pe"
            register={(name) => form.register(`contact.${name}`)}
            errors={form.formState.errors.contact ?? {}}
          />
          <FormActions submitLabel={t('common.save')} pending={save.isPending} onCancel={close} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Puts the person in a company with a role, or changes their role or access there. */
function MembershipDialog({ user, onClose, onSaved }: { user: UserRow | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const roleHint = useRoleHint();
  const id = useId();
  const companies = useCompanies(user !== null);
  const [companyId, setCompanyId] = useState<string>();
  const [role, setRole] = useState<Role>();
  const [isActive, setIsActive] = useState(true);
  const [formError, setFormError] = useState<string>();

  const pick = (next: string) => {
    setCompanyId(next);
    const existing = user?.memberships.find((m) => m.companyId === next);
    setRole(existing?.role);
    setIsActive(existing?.isActive ?? true);
  };

  const close = () => {
    setCompanyId(undefined);
    setRole(undefined);
    setIsActive(true);
    setFormError(undefined);
    onClose();
  };

  const save = useMutation({
    mutationFn: () => api.put(`/platform/users/${user!.id}/memberships/${companyId}`, { role, isActive }),
    onSuccess: () => {
      close();
      onSaved();
    },
    onError: (error) => setFormError(errorMessage(t, error)),
  });

  return (
    <Dialog open={user !== null} onOpenChange={(open) => !open && !save.isPending && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('platformUsers.membership')}</DialogTitle>
          <DialogDescription>{user && t('platformUsers.membershipDescription', { name: user.fullName })}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setFormError(undefined);
            if (!companyId || !role) {
              setFormError(t('platformUsers.membershipIncomplete'));
              return;
            }
            save.mutate();
          }}
        >
          <FormError message={formError} />
          <Field id={`${id}-company`} label={t('platform.company')}>
            <Select value={companyId} onValueChange={pick}>
              <SelectTrigger id={`${id}-company`} className="w-full">
                <SelectValue placeholder={t('platformUsers.chooseCompany')} />
              </SelectTrigger>
              <SelectContent>
                {companies.data?.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id={`${id}-role`} label={t('users.role')} hint={roleHint(role)}>
            <RoleSelect id={`${id}-role`} value={role} onChange={setRole} />
          </Field>
          <div className="flex min-h-10 items-center gap-3">
            <Checkbox id={`${id}-active`} checked={isActive} onCheckedChange={(v) => setIsActive(v === true)} />
            <Label htmlFor={`${id}-active`}>{t('platformUsers.hasAccess')}</Label>
          </div>
          <FormActions submitLabel={t('common.save')} pending={save.isPending} onCancel={close} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
