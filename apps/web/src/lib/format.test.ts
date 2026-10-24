import { describe, expect, it } from 'vitest';
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
} from './format';

// Intl uses non-breaking spaces as group separators; compare with plain spaces.
const plain = (s: string) => s.replace(/[  ]/g, ' ');

describe('formatMoney', () => {
  it('formats UZS per language without empty decimals', () => {
    expect(plain(formatMoney(7500000, 'UZS', 'uz'))).toBe('7 500 000 soʻm');
    expect(plain(formatMoney(7500000, 'UZS', 'ru'))).toBe('7 500 000 UZS');
    expect(plain(formatMoney(7500000, 'UZS', 'tr'))).toBe('UZS 7.500.000');
    expect(plain(formatMoney(7500000, 'UZS', 'en'))).toBe('UZS 7,500,000');
  });

  it('keeps real fractions and formats decimal strings exactly', () => {
    expect(plain(formatMoney('33333.33', 'UZS', 'en'))).toBe('UZS 33,333.33');
    expect(plain(formatMoney('12345678901234.56', 'UZS', 'en'))).toBe('UZS 12,345,678,901,234.56');
  });
});

describe('formatSignedMoney', () => {
  it('always shows the sign, with a real minus, and none on zero', () => {
    expect(plain(formatSignedMoney('-300000.00', 'UZS', 'uz'))).toBe('−300 000 soʻm');
    expect(plain(formatSignedMoney('500000.50', 'UZS', 'uz'))).toBe('+500 000,5 soʻm');
    expect(plain(formatSignedMoney('0.00', 'UZS', 'en'))).toBe('UZS 0');
    expect(plain(formatSignedMoney('-0.00', 'UZS', 'en'))).toBe('UZS 0');
  });
});

describe('formatNumber', () => {
  it('groups digits per language', () => {
    expect(plain(formatNumber(1234.5, 'ru'))).toBe('1 234,5');
    expect(plain(formatNumber(1234.5, 'uz'))).toBe('1 234,5');
    expect(formatNumber(1234.5, 'en')).toBe('1,234.5');
  });
});

describe('Uzbek formatting does not depend on browser locale data', () => {
  it('formats money, dates and months by hand', () => {
    expect(plain(formatMoney('12345678.5', 'UZS', 'uz'))).toBe('12 345 678,5 soʻm');
    expect(plain(formatMoney(100, 'USD', 'uz'))).toBe('100 USD');
    expect(formatDate('2026-10-19', 'uz')).toBe('19.10.2026');
    expect(formatMonth(2026, 1, 'uz')).toBe('yanvar, 2026');
  });

  it('shows API timestamps as the day in the viewer’s time zone', () => {
    // 20:30 UTC is already the next day in Tashkent (UTC+5).
    const original = process.env.TZ;
    process.env.TZ = 'Asia/Tashkent';
    try {
      expect(formatDate('2026-10-19T20:30:00.000Z', 'uz')).toBe('20.10.2026');
      expect(formatDate('2026-10-19T20:30:00.000Z', 'en')).toBe('Oct 20, 2026');
      // A calendar day stays the same day regardless.
      expect(formatDate('2026-10-19', 'en')).toBe('Oct 19, 2026');
    } finally {
      process.env.TZ = original;
    }
  });
});

describe('formatDate', () => {
  it('does not shift calendar dates across time zones', () => {
    expect(formatDate('2026-09-01', 'en')).toBe('Sep 1, 2026');
    expect(formatDate('2026-09-01', 'tr')).toBe('1 Eyl 2026');
  });

  it('rejects malformed dates', () => {
    expect(() => formatDate('01.09.2026', 'en')).toThrow();
  });
});

describe('formatMonth', () => {
  it('names the month in each language', () => {
    expect(formatMonth(2026, 9, 'en')).toBe('September 2026');
    expect(formatMonth(2026, 9, 'tr')).toBe('Eylül 2026');
    expect(formatMonth(2026, 9, 'uz')).toBe('sentabr, 2026');
  });
});

describe('weekday and month names', () => {
  it('names ISO weekdays and months per language, Uzbek by hand', () => {
    expect(formatWeekday(1, 'uz')).toBe('dushanba');
    expect(formatWeekday(7, 'uz')).toBe('yakshanba');
    expect(formatWeekday(1, 'en')).toBe('Monday');
    expect(formatWeekday(7, 'ru')).toBe('воскресенье');
    expect(formatMonthName(11, 'uz')).toBe('noyabr');
    expect(formatMonthName(11, 'ru')).toBe('ноябрь');
    expect(formatMonthName(11, 'tr')).toBe('Kasım');
    expect(formatWeekdayShort(1, 'uz')).toBe('Du');
    expect(formatWeekdayShort(7, 'uz')).toBe('Ya');
    expect(formatWeekdayShort(1, 'en')).toBe('Mon');
  });
});

describe('formatTime', () => {
  it('shows the time of day in the viewer’s time zone, 24-hour in Uzbek', () => {
    const moment = new Date(2026, 9, 19, 9, 5);
    expect(formatTime(moment, 'uz')).toBe('09:05');
    expect(formatTime(moment.toISOString(), 'ru')).toBe('09:05');
    expect(formatTime(moment, 'en')).toBe('9:05 AM');
  });
});
