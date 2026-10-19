import { Monitor, Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTheme, type Theme } from '@/components/theme-provider';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const THEMES = [
  { value: 'light', icon: Sun, labelKey: 'settings.themeLight' },
  { value: 'dark', icon: Moon, labelKey: 'settings.themeDark' },
  { value: 'system', icon: Monitor, labelKey: 'settings.themeSystem' },
] as const;

export function ThemeSwitcher() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const CurrentIcon = THEMES.find((x) => x.value === theme)?.icon ?? Monitor;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('settings.theme')}>
          <CurrentIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t('settings.theme')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as Theme)}>
          {THEMES.map(({ value, icon: Icon, labelKey }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <Icon aria-hidden />
              {t(labelKey)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
