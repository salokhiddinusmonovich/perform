import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { isLanguage, type Language } from '@/i18n';
import {
  formatDate,
  formatMoney,
  formatMonth,
  formatMonthName,
  formatNumber,
  formatSignedMoney,
  formatTime,
  formatWeekday,
  formatWeekdayShort,
  type DecimalInput,
} from '@/lib/format';

/** Formatters bound to the current UI language. Use this in components, not Intl directly. */
export function useFormat() {
  const { i18n } = useTranslation();
  const lang: Language = isLanguage(i18n.language) ? i18n.language : 'en';

  return useMemo(
    () => ({
      money: (value: DecimalInput, currency: string) => formatMoney(value, currency, lang),
      signedMoney: (value: string, currency: string) => formatSignedMoney(value, currency, lang),
      number: (value: DecimalInput, maxFractionDigits?: number) =>
        formatNumber(value, lang, maxFractionDigits),
      date: (value: string | Date) => formatDate(value, lang),
      time: (value: string | Date) => formatTime(value, lang),
      month: (year: number, month: number) => formatMonth(year, month, lang),
      /** The month of a calendar day "YYYY-MM-DD", e.g. a plan's or payment's month "YYYY-MM-01" */
      monthOf: (day: string) => formatMonth(Number(day.slice(0, 4)), Number(day.slice(5, 7)), lang),
      monthName: (month: number) => formatMonthName(month, lang),
      weekday: (isoWeekday: number) => formatWeekday(isoWeekday, lang),
      weekdayShort: (isoWeekday: number) => formatWeekdayShort(isoWeekday, lang),
    }),
    [lang],
  );
}
