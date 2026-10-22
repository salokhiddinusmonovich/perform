import type { Locale } from 'date-fns';
import { enUS, ru, tr, uz } from 'date-fns/locale';
import { CalendarIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useFormat } from '@/hooks/use-format';
import { isLanguage, type Language } from '@/i18n';
import { cn } from '@/lib/utils';

const LOCALES: Record<Language, Locale> = { uz, ru, tr, en: enUS };

interface DatePickerProps {
  id: string;
  /** A calendar day, "YYYY-MM-DD", or '' for none. */
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  /** Month shown when nothing is picked yet, "YYYY-MM-DD". */
  defaultMonth?: string;
}

/** A calendar day (no time, no time zone): shown and picked as that exact day. */
const toLocalDate = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const toDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** The one date picker (AGENTS.md: shadcn Calendar with date-fns locales). */
export function DatePicker({ id, value, onChange, invalid, defaultMonth }: DatePickerProps) {
  const { t, i18n } = useTranslation();
  const format = useFormat();
  const [open, setOpen] = useState(false);
  const lang: Language = isLanguage(i18n.language) ? i18n.language : 'en';
  const selected = value ? toLocalDate(value) : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          aria-invalid={invalid ? true : undefined}
          className={cn('w-full justify-start font-normal', !value && 'text-muted-foreground')}
        >
          <CalendarIcon aria-hidden />
          {value ? format.date(value) : t('common.pickDate')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          locale={LOCALES[lang]}
          weekStartsOn={1}
          selected={selected}
          defaultMonth={selected ?? (defaultMonth ? toLocalDate(defaultMonth) : undefined)}
          onSelect={(date) => {
            if (!date) return;
            onChange(toDay(date));
            setOpen(false);
          }}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  );
}
