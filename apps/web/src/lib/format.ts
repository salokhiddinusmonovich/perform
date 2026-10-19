/**
 * The only place dates, numbers and money are formatted (see AGENTS.md).
 * Pages use `useFormat()`, which binds these to the current UI language.
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

/** e.g. uz: "7 500 000 soʻm", en: "UZS 7,500,000". Fractions are shown only when present. */
export function formatMoney(value: DecimalInput, currency: string, lang: Language): string {
  return new Intl.NumberFormat(localeOf(lang), {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value as IntlDecimal);
}

export function formatNumber(value: DecimalInput, lang: Language, maxFractionDigits = 2): string {
  return new Intl.NumberFormat(localeOf(lang), {
    maximumFractionDigits: maxFractionDigits,
  }).format(value as IntlDecimal);
}

/**
 * Formats a calendar date stored as "YYYY-MM-DD" (or a Date at UTC midnight).
 * Uses UTC so the day never shifts with the viewer's time zone.
 */
export function formatDate(value: string | Date, lang: Language): string {
  return new Intl.DateTimeFormat(localeOf(lang), {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(toUtcDate(value));
}

/** Month heading, e.g. "sentabr, 2026" / "September 2026". `month` is 1-based. */
export function formatMonth(year: number, month: number, lang: Language): string {
  return new Intl.DateTimeFormat(localeOf(lang), {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function toUtcDate(value: string | Date): Date {
  if (value instanceof Date) return value;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) throw new Error(`Invalid date: ${value}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}
