import { describe, expect, it } from 'vitest';
import { formatDate, formatMoney, formatMonth, formatNumber } from './format';

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

describe('formatNumber', () => {
  it('groups digits per language', () => {
    expect(plain(formatNumber(1234.5, 'ru'))).toBe('1 234,5');
    expect(formatNumber(1234.5, 'en')).toBe('1,234.5');
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
