import { HardHat, Menu } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router';
import { LanguageSwitcher } from '@/components/language-switcher';
import { ThemeSwitcher } from '@/components/theme-switcher';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { NAV_ITEMS } from './nav';

/** Layout shared by every page: sidebar (desktop), slide-out menu (phones), header. */
export function AppShell() {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="flex min-h-svh">
      <aside className="hidden w-60 shrink-0 border-r bg-sidebar text-sidebar-foreground lg:flex lg:flex-col">
        <Brand />
        <Navigation />
      </aside>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="w-72 bg-sidebar p-0 text-sidebar-foreground">
          <SheetHeader className="sr-only">
            <SheetTitle>{t('nav.label')}</SheetTitle>
            <SheetDescription>{t('app.tagline')}</SheetDescription>
          </SheetHeader>
          <Brand />
          <Navigation onNavigate={() => setMenuOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
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
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
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

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t('nav.label')} className="flex flex-1 flex-col gap-1 p-3">
      {NAV_ITEMS.map(({ path, labelKey, icon: Icon }) => (
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
    </nav>
  );
}
