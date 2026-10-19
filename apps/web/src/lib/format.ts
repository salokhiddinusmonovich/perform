/**
 * The only place dates, numbers and money are formatted (see AGENTS.md).
 * Pages use `useFormat()`, which binds these to the current UI language.
 *
 * Uzbek is formatted here by hand: many browsers (embedded Chromium, some Android
 * builds) ship without Uzbek locale data, and Intl then prints "2026 M10 19" or
 * English-style numbers. Russian, Turkish and English use Intl.
 */
import type { Language } from '@/i18n';

const LOCALES: Record<Language, string> = {
  uz: 'uz-Latn-UZ',
  ru: 'ru-RU',
  tr: 'tr-TR',
  en: 'en-US',
};

export function localeOf(lang: Language): string {
  return LOCALES[lang];
}

/** Decimal values from the API arrive as strings; Intl formats them exactly. */
export type DecimalInput = number | string;

type IntlDecimal = Parameters<Intl.NumberFormat['format']>[0];

const UZ_MONTHS = [
  'yanvar',
  'fevral',
  'mart',
  'aprel',
  'may',
  'iyun',
  'iyul',
  'avgust',
  'sentabr',
  'oktabr',
  'noyabr',
  'dekabr',
];
const NBSP = ' ';

/** Uzbek number style: "1 234 567,5" (space groups, decimal comma). */
function uzNumber(value: DecimalInput, minFraction: number, maxFraction: number): string {
  // en-US is available everywhere and formats decimal strings exactly; swap separators.
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: minFraction, maximumFractionDigits: maxFraction })
    .format(value as IntlDecimal)
    .replace(/[,.]/g, (sep) => (sep === ',' ? NBSP : ','));
}

/** e.g. uz: "7 500 000 soʻm", en: "UZS 7,500,000". Fractions are shown only when present. */
export function formatMoney(value: DecimalInput, currency: string, lang: Language): string {
  if (lang === 'uz') {
    const amount = uzNumber(value, 0, 2);
    return currency === 'UZS' ? `${amount}${NBSP}soʻm` : `${amount}${NBSP}${currency}`;
  }
  return new Intl.NumberFormat(localeOf(lang), {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value as IntlDecimal);
}

export function formatNumber(value: DecimalInput, lang: Language, maxFractionDigits = 2): string {
  if (lang === 'uz') return uzNumber(value, 0, maxFractionDigits);
  return new Intl.NumberFormat(localeOf(lang), {
    maximumFractionDigits: maxFractionDigits,
  }).format(value as IntlDecimal);
}

/**
 * Formats either a calendar day stored as "YYYY-MM-DD" (shown as that exact day,
 * whatever the viewer's time zone) or a moment in time such as an API timestamp
 * (shown as the day it was in the viewer's time zone).
 */
export function formatDate(value: string | Date, lang: Language): string {
  const { date, calendarDay } = parseDate(value);
  if (lang === 'uz') {
    const [d, m, y] = calendarDay
      ? [date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCFullYear()]
      : [date.getDate(), date.getMonth() + 1, date.getFullYear()];
    return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`;
  }
  return new Intl.DateTimeFormat(localeOf(lang), {
    dateStyle: 'medium',
    ...(calendarDay && { timeZone: 'UTC' }),
  }).format(date);
}

/** Month heading, e.g. "sentabr, 2026" / "September 2026". `month` is 1-based. */
export function formatMonth(year: number, month: number, lang: Language): string {
  if (lang === 'uz') return `${UZ_MONTHS[month - 1]}, ${year}`;
  return new Intl.DateTimeFormat(localeOf(lang), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

function parseDate(value: string | Date): { date: Date; calendarDay: boolean } {
  if (value instanceof Date) return { date: value, calendarDay: false };
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (day) {
    return { date: new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]))), calendarDay: true };
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const instant = new Date(value);
    if (!Number.isNaN(instant.getTime())) return { date: instant, calendarDay: false };
  }
  throw new Error(`Invalid date: ${value}`);
}
