import { describe, expect, it } from 'vitest';
import {
  hoursStatus,
  matchesAdjustmentFilter,
  payrollSiteNames,
  payslipsOf,
  siteChoices,
  type AdjustmentItem,
  type FirmRef,
  type PayrollPart,
  type PayrollPayOut,
} from './payroll';

const entry = {} as never;
const part = (...siteNames: string[]) =>
  ({ places: Object.fromEntries(siteNames.map((siteName, i) => [i, { siteName, from: null, until: null }])) }) as unknown as PayrollPart;
const adjustment = (type: AdjustmentItem['type'], cancelled = false) =>
  ({ type, cancelled: cancelled ? { reason: 'x' } : null }) as AdjustmentItem;

describe('payrollSiteNames', () => {
  it('uses the saved sites, so a worker with problems and no parts still has them', () => {
    expect(payrollSiteNames({ siteNames: ['North'], parts: [] })).toEqual(['North']);
  });

  it('reads the pay parts of a month locked before sites were saved, each site once', () => {
    expect(payrollSiteNames({ parts: [part('North', 'South'), part('North')] })).toEqual(['North', 'South']);
  });
});

describe('payslipsOf', () => {
  const payOut = { total: '100.00' } as PayrollPayOut;
  const firm = (id: string): FirmRef => ({ id, name: id, type: 'OWN' });

  it('gives each firm its own parts', () => {
    const first = { firm: firm('a') } as PayrollPart;
    const second = { firm: firm('b') } as PayrollPart;
    const slip = (id: string) => ({ firm: firm(id), salary: null, payOut, total: '100.00' });
    const slips = payslipsOf({ parts: [first, second], payOut: null, payslips: [slip('a'), slip('b')], salary: null, total: '200.00' });
    expect(slips.map((s) => s.parts)).toEqual([[first], [second]]);
  });

  it('reads the one pay-out of a month locked before firms', () => {
    const parts = [{} as PayrollPart];
    expect(payslipsOf({ parts, payOut, salary: null, total: '100.00' })).toEqual([
      { firm: null, salary: null, payOut, total: '100.00', parts },
    ]);
  });

  it('has none while the worker cannot be paid', () => {
    expect(payslipsOf({ parts: [], payOut: null, salary: null, total: null })).toEqual([]);
  });
});

describe('siteChoices', () => {
  it('offers each name once, sorted', () => {
    expect(siteChoices(['South', 'North', 'South'])).toEqual([
      { value: 'North', name: 'North' },
      { value: 'South', name: 'South' },
    ]);
  });
});

describe('hoursStatus', () => {
  it('puts daily entries first, then entered totals, then a shift change, then nothing entered', () => {
    expect(hoursStatus({ hasDailyEntries: true, history: [entry], outdated: [] })).toBe('dailyEntries');
    expect(hoursStatus({ hasDailyEntries: false, history: [entry], outdated: [entry] })).toBe('entered');
    expect(hoursStatus({ hasDailyEntries: false, history: [], outdated: [entry] })).toBe('shiftChanged');
    expect(hoursStatus({ hasDailyEntries: false, history: [], outdated: [] })).toBe('notEntered');
  });
});

describe('matchesAdjustmentFilter', () => {
  it('counts a type only while it is not cancelled', () => {
    const items = [adjustment('BONUS', true), adjustment('ADVANCE')];
    expect(matchesAdjustmentFilter('ADVANCE', items)).toBe(true);
    expect(matchesAdjustmentFilter('BONUS', items)).toBe(false);
  });

  it('finds cancelled ones, and leaves out workers with only those from "with adjustments"', () => {
    const cancelledOnly = [adjustment('BONUS', true)];
    expect(matchesAdjustmentFilter('cancelled', cancelledOnly)).toBe(true);
    expect(matchesAdjustmentFilter('any', cancelledOnly)).toBe(false);
    expect(matchesAdjustmentFilter('all', [])).toBe(true);
  });
});
