import { describe, expect, it } from 'vitest';
import { dayToDate } from '../src/common/dates';
import { subscriptionState } from '../src/platform/subscription';

describe('subscription state', () => {
  const company = (paidThrough: string | null) => ({
    paidThrough: paidThrough ? dayToDate(paidThrough) : null,
    plan: { name: 'Standard' },
  });

  it('is active through the last day of the paid month, then 14 days of grace, then read-only', () => {
    const october = company('2026-10-01');
    const at = (today: string) => subscriptionState(october, today);
    expect(at('2026-10-01')).toEqual({ status: 'ACTIVE', planName: 'Standard', paidThrough: '2026-10-01', graceEndsOn: '2026-11-14' });
    expect(at('2026-10-31').status).toBe('ACTIVE');
    expect(at('2026-11-01').status).toBe('GRACE');
    expect(at('2026-11-14').status).toBe('GRACE');
    expect(at('2026-11-15').status).toBe('READ_ONLY');
  });

  it('counts the paid month to its real last day', () => {
    expect(subscriptionState(company('2028-02-01'), '2028-02-29').status).toBe('ACTIVE');
    expect(subscriptionState(company('2028-02-01'), '2028-03-01').status).toBe('GRACE');
    expect(subscriptionState(company('2026-12-01'), '2026-12-31').graceEndsOn).toBe('2027-01-14');
  });

  it('never expires without a paid month', () => {
    expect(subscriptionState(company(null), '2030-01-01')).toEqual({
      status: 'NONE',
      planName: 'Standard',
      paidThrough: null,
      graceEndsOn: null,
    });
  });
});
