import { HardHat } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LanguageSwitcher } from '@/components/language-switcher';
import { ThemeSwitcher } from '@/components/theme-switcher';

/** Centered card layout for pages outside the app shell (login, forced password change). */
export function AuthLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex h-14 items-center justify-end gap-1 px-4">
        <LanguageSwitcher />
        <ThemeSwitcher />
      </header>
      <main className="flex flex-1 flex-col items-center px-4 pt-8 pb-16 sm:pt-16">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <HardHat className="size-6" aria-hidden />
          </div>
          <div className="leading-tight">
            <div className="text-lg font-semibold">{t('app.name')}</div>
            <div className="text-sm text-muted-foreground">{t('app.tagline')}</div>
          </div>
        </div>
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}
