import { HardHat, Menu } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router';
import { ErrorState } from '@/components/error-state';
import { LanguageSwitcher } from '@/components/language-switcher';
import { LoadingState } from '@/components/loading-state';
import { ImpersonationBanner, SubscriptionBanner } from '@/components/session-banners';
import { ThemeSwitcher } from '@/components/theme-switcher';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { UserMenu } from '@/components/user-menu';
import { useMe, type Me } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { NAV_SECTIONS } from './nav';

/**
 * Layout shared by every page inside the app: sidebar (desktop), slide-out menu
 * (phones), header. Only logged-in users get here; a pending temporary password
 * sends them to change it first.
 */
export function AppShell() {
  const { t } = useTranslation();
  const location = useLocation();
  const me = useMe();
  const [menuOpen, setMenuOpen] = useState(false);

  if (me.isPending) return <LoadingState />;
  if (me.isError) return <ErrorState onRetry={() => me.refetch()} />;
  if (!me.data) {
    const next = location.pathname + location.search;
    return <Navigate to={next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`} replace />;
  }
  // A platform admin acting as someone isn't asked to choose that person's password.
  if (me.data.user.mustChangePassword && !me.data.impersonation) return <Navigate to="/change-password" replace />;

  return (
    <div className="flex min-h-svh">
      <aside className="hidden w-60 shrink-0 border-r bg-sidebar text-sidebar-foreground lg:flex lg:flex-col">
        <Brand />
        <Navigation me={me.data} />
      </aside>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="w-72 bg-sidebar p-0 text-sidebar-foreground">
          <SheetHeader className="sr-only">
            <SheetTitle>{t('nav.label')}</SheetTitle>
            <SheetDescription>{t('app.tagline')}</SheetDescription>
          </SheetHeader>
          <Brand />
          <Navigation me={me.data} onNavigate={() => setMenuOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <ImpersonationBanner me={me.data} />
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setMenuOpen(true)}
            aria-label={t('nav.openMenu')}
          >
            <Menu aria-hidden />
          </Button>
          <span className="font-semibold lg:hidden">{t('app.name')}</span>
          <div className="ml-auto flex items-center gap-1">
            <LanguageSwitcher />
            <ThemeSwitcher />
            <UserMenu me={me.data} />
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <SubscriptionBanner me={me.data} />
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function Brand() {
  const { t } = useTranslation();
  return (
    <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-4">
      <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <HardHat className="size-5" aria-hidden />
      </div>
      <div className="min-w-0 leading-tight">
        <div className="font-semibold">{t('app.name')}</div>
        <div className="truncate text-xs text-muted-foreground">{t('app.tagline')}</div>
      </div>
    </div>
  );
}

function Navigation({ me, onNavigate }: { me: Me; onNavigate?: () => void }) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t('nav.label')} className="flex flex-1 flex-col gap-4 p-3">
      {NAV_SECTIONS.map((section, i) => {
        const items = section.items.filter((item) => !item.visible || item.visible(me));
        if (items.length === 0) return null;
        return (
          <div key={section.titleKey ?? i} className="flex flex-col gap-1">
            {section.titleKey && (
              <div className="px-3 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {t(section.titleKey)}
              </div>
            )}
            {items.map(({ path, labelKey, icon: Icon }) => (
              <NavLink
                key={path}
                to={path}
                end={path === '/'}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    'flex min-h-10 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors',
                    'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                    isActive && 'bg-sidebar-accent text-sidebar-accent-foreground',
                  )
                }
              >
                <Icon className="size-4" aria-hidden />
                {t(labelKey)}
              </NavLink>
            ))}
          </div>
        );
      })}
    </nav>
  );
}
