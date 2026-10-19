import { useMutation } from '@tanstack/react-query';
import { Check, ChevronsUpDown, KeyRound, LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import { useResetSession, type Me } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';

/** Name, role, company switch, password change and logout. */
export function UserMenu({ me }: { me: Me }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const resetSession = useResetSession();

  const logout = useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSettled: async () => {
      // Finish leaving the page (the login page loads on demand) before forgetting the
      // session; otherwise the shell sees "logged out on this page" and sends the next
      // person who logs in on this device back here (?next=…).
      await navigate('/login', { replace: true });
      await resetSession();
    },
  });

  const switchCompany = useMutation({
    mutationFn: (companyId: string) => api.post('/auth/switch-company', { companyId }),
    onSuccess: async () => {
      await resetSession();
      navigate('/', { replace: true });
    },
    onError: (error) => toast.error(errorMessage(t, error)),
  });

  const contact = me.user.phone ?? me.user.email ?? '';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="max-w-56 gap-2 px-2" aria-label={t('nav.userMenu')}>
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
            {initials(me.user.fullName)}
          </span>
          <span className="hidden min-w-0 text-left leading-tight md:block">
            <span className="block truncate text-sm font-medium">{me.user.fullName}</span>
            {me.activeCompany && (
              <span className="block truncate text-xs text-muted-foreground">{me.activeCompany.name}</span>
            )}
          </span>
          <ChevronsUpDown className="hidden size-4 text-muted-foreground md:block" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-normal">
          <div className="truncate font-medium">{me.user.fullName}</div>
          <div className="truncate text-xs text-muted-foreground">{contact}</div>
          {me.activeCompany && (
            <div className="truncate text-xs text-muted-foreground">
              {me.activeCompany.name} · {t(`roles.${me.activeCompany.role}`)}
            </div>
          )}
        </DropdownMenuLabel>

        {me.companies.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">{t('nav.switchCompany')}</DropdownMenuLabel>
            {me.companies.map((c) => (
              <DropdownMenuItem
                key={c.id}
                disabled={switchCompany.isPending}
                onSelect={() => c.id !== me.activeCompany?.id && switchCompany.mutate(c.id)}
              >
                <Check className={c.id === me.activeCompany?.id ? '' : 'invisible'} aria-hidden />
                <span className="truncate">{c.name}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/change-password')}>
          <KeyRound aria-hidden />
          {t('nav.changePassword')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => logout.mutate()} disabled={logout.isPending}>
          <LogOut aria-hidden />
          {t('nav.logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}
