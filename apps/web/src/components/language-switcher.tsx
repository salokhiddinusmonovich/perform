import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { isLanguage, LANGUAGES, setLanguage } from '@/i18n';

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" aria-label={t('settings.language')}>
          <Languages aria-hidden />
          <span className="hidden sm:inline">
            {isLanguage(i18n.language) ? LANGUAGES[i18n.language] : i18n.language}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t('settings.language')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={i18n.language}
          onValueChange={(value) => isLanguage(value) && setLanguage(value)}
        >
          {Object.entries(LANGUAGES).map(([code, name]) => (
            <DropdownMenuRadioItem key={code} value={code} lang={code}>
              {name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
