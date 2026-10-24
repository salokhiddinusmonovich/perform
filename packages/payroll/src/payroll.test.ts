import { describe, expect, it } from 'vitest';
import { buildMonthCalendar, countWorkdays, workingDays } from './calendar.js';
import { divRound, fromUnits, toUnits } from './decimal.js';
import { normalizeCode, parseCell, type CodeMap, type DayEntry } from './entry.js';
import { missingMovingHolidays, uzbekistanFixedHolidays } from './holidays.js';
import { calculatePay, type PaySettings, type TravelInput } from './pay.js';
import { payOut } from './pay-out.js';
import { checkTotals, summarizeMonth, type MonthlyTotals } from './summary.js';

// September 2026: Sept 1 (Tue) is Independence Day, Sundays are 6/13/20/27.
const september = buildMonthCalendar(2026, 9, { restWeekdays: [7], holidays: ['2026-09-01'] });

/** Made-up company codes, like the ones in customer Excel files. */
const codes: CodeMap = new Map([
  [normalizeCode('T'), 'OFF'],
  [normalizeCode('B/T'), 'OFF'],
  [normalizeCode('Y'), 'ABSENT'],
  [normalizeCode('IZ'), 'LEAVE'],
  [normalizeCode('İ'), 'LEAVE'],
  [normalizeCode('R'), 'SICK'],
  [normalizeCode('TR'), 'TRAVEL'],
  [normalizeCode('-'), 'NOT_EMPLOYED'],
]);

/** Entries at Site A unless a test says otherwise; seq only matters for days worked at several places. */
const worked = (date: string, hours: string, place = 'Site A', seq = 1): DayEntry => ({
  date,
  place,
  seq,
  status: 'WORKED',
  hours,
});
const status = (date: string, s: DayEntry['status'], place = 'Site A'): DayEntry => ({
  date,
  place,
  seq: 1,
  status: s,
  hours: '0',
});

/** Every working day at `hours`, everything else OFF; `overrides` replace whole days. */
function month(hours: string, overrides: DayEntry[] = []): DayEntry[] {
  return september.flatMap((d) => {
    const replaced = overrides.filter((e) => e.date === d.date);
    if (replaced.length > 0) return replaced;
    return [d.kind === 'WORKDAY' ? worked(d.date, hours) : status(d.date, 'OFF')];
  });
}

const settings: PaySettings = {
  normalHoursPerDay: '9',
  multipliers: { NORMAL: '1', OVERTIME: '1.5', REST_DAY: '2', HOLIDAY: '2' },
  absence: {
    SICK: { paid: true, hoursPerDay: '8' },
    LEAVE: { paid: true, hoursPerDay: null },
    TRAVEL: { paid: false, hoursPerDay: null },
  },
};

describe('decimals', () => {
  it('round-trips 2-decimal strings exactly', () => {
    expect(toUnits('7500000')).toBe(750000000n);
    expect(toUnits('0.1')).toBe(10n);
    expect(toUnits('-3.05')).toBe(-305n);
    expect(fromUnits(750000050n)).toBe('7500000.50');
    expect(fromUnits(-5n)).toBe('-0.05');
  });

  it('rejects values it would have to round', () => {
    expect(() => toUnits('1.005')).toThrow(RangeError);
    expect(() => toUnits('1e3')).toThrow(RangeError);
    expect(() => toUnits('')).toThrow(RangeError);
  });

  it('rounds halves away from zero', () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(4n, 3n)).toBe(1n);
    expect(divRound(5n, 3n)).toBe(2n);
  });
});

describe('calendar', () => {
  it('has 25 working days in September 2026', () => {
    expect(september).toHaveLength(30);
    expect(countWorkdays(september)).toBe(25);
  });

  it('marks holidays and rest weekdays', () => {
    expect(september[0]).toMatchObject({ date: '2026-09-01', weekday: 2, kind: 'HOLIDAY' });
    expect(september[5]).toMatchObject({ date: '2026-09-06', weekday: 7, kind: 'REST_DAY' });
  });

  it('counts a holiday on a rest weekday as a holiday', () => {
    // 2026-03-08 is a Sunday.
    const march = buildMonthCalendar(2026, 3, { restWeekdays: [7], holidays: ['2026-03-08'] });
    expect(march[7]).toMatchObject({ weekday: 7, kind: 'HOLIDAY' });
  });

  it('keeps the calculated and overridden working days side by side', () => {
    expect(workingDays(september)).toEqual({ calculated: 25, override: null, effective: 25 });
    expect(workingDays(september, 24)).toEqual({ calculated: 25, override: 24, effective: 24 });
    expect(() => workingDays(september, 0)).toThrow(RangeError);
    expect(() => workingDays(september, 31)).toThrow(RangeError);
  });

  it('turns a rest weekday into a working day when a day-off swap says so', () => {
    // Government swap: Monday 2026-09-07 off, Sunday 2026-09-13 worked instead.
    const swapped = buildMonthCalendar(2026, 9, {
      restWeekdays: [7],
      holidays: ['2026-09-01', '2026-09-07'],
      extraWorkdays: ['2026-09-13'],
    });
    expect(swapped[6]).toMatchObject({ date: '2026-09-07', kind: 'HOLIDAY' });
    expect(swapped[12]).toMatchObject({ date: '2026-09-13', weekday: 7, kind: 'WORKDAY' });
    expect(countWorkdays(swapped)).toBe(25);
    // Already a working day at a site with other rest days: nothing changes.
    const sixDay = buildMonthCalendar(2026, 9, { restWeekdays: [6, 7], holidays: [], extraWorkdays: ['2026-09-14'] });
    expect(sixDay[13]).toMatchObject({ date: '2026-09-14', kind: 'WORKDAY' });
    expect(() =>
      buildMonthCalendar(2026, 9, { restWeekdays: [7], holidays: ['2026-09-13'], extraWorkdays: ['2026-09-13'] }),
    ).toThrow(RangeError);
  });

  it('rejects invalid rest weekdays', () => {
    expect(() => buildMonthCalendar(2026, 9, { restWeekdays: [0], holidays: [] })).toThrow(RangeError);
  });
});

describe('Uzbekistan holidays', () => {
  it('ships the fixed-date public holidays for any year', () => {
    expect(uzbekistanFixedHolidays(2027).map((h) => h.date)).toEqual([
      '2027-01-01',
      '2027-03-08',
      '2027-03-21',
      '2027-05-09',
      '2027-09-01',
      '2027-10-01',
      '2027-12-08',
    ]);
  });

  it('warns about moving holidays not entered for the year', () => {
    expect(missingMovingHolidays([])).toEqual(['RAMAZON_HAYIT', 'QURBON_HAYIT']);
    expect(missingMovingHolidays(['RAMAZON_HAYIT', 'COMPANY_DAY_OFF'])).toEqual(['QURBON_HAYIT']);
    expect(missingMovingHolidays(['QURBON_HAYIT', 'RAMAZON_HAYIT'])).toEqual([]);
  });
});

describe('parseCell', () => {
  it('reads hours', () => {
    expect(parseCell(12, codes, true)).toEqual({ status: 'WORKED', hours: '12.00' });
    expect(parseCell('9', codes, true)).toEqual({ status: 'WORKED', hours: '9.00' });
    expect(parseCell('7,5', codes, true)).toEqual({ status: 'WORKED', hours: '7.50' });
    expect(parseCell(24, codes, true)).toEqual({ status: 'WORKED', hours: '24.00' });
  });

  it("reads the company's codes, folding Turkish and Latin i", () => {
    expect(parseCell('T', codes, true)?.status).toBe('OFF');
    expect(parseCell(' y ', codes, true)?.status).toBe('ABSENT');
    expect(parseCell('iz', codes, true)?.status).toBe('LEAVE');
    expect(parseCell('İ', codes, true)?.status).toBe('LEAVE');
    expect(parseCell('i', codes, true)?.status).toBe('LEAVE');
  });

  it('returns null for anything it cannot understand', () => {
    expect(parseCell('???', codes, true)).toBeNull();
    expect(parseCell(-3, codes, true)).toBeNull();
    expect(parseCell('-3', codes, true)).toBeNull();
    expect(parseCell(25, codes, true)).toBeNull();
    expect(parseCell(7.499999, codes, true)).toBeNull();
    expect(parseCell(Number.NaN, codes, true)).toBeNull();
    expect(parseCell(true, codes, true)).toBeNull();
    expect(parseCell(0, codes, true)).toBeNull();
    expect(parseCell(0, new Map([...codes, ['0', 'OFF']]), true)?.status).toBe('OFF');
  });

  it('decides blank cells by the employment dates', () => {
    // Before hire or after exit: blank or a "not employed" code.
    expect(parseCell(null, codes, false)).toEqual({ status: 'NOT_EMPLOYED', hours: '0' });
    expect(parseCell(undefined, codes, false)?.status).toBe('NOT_EMPLOYED');
    expect(parseCell('  ', codes, false)?.status).toBe('NOT_EMPLOYED');
    expect(parseCell('-', codes, false)?.status).toBe('NOT_EMPLOYED');
    // While employed a blank is missing data, and "not employed" contradicts the dates.
    expect(parseCell(null, codes, true)).toBeNull();
    expect(parseCell('', codes, true)).toBeNull();
    expect(parseCell('-', codes, true)).toBeNull();
    // Hours or other codes outside employment are problems too.
    expect(parseCell(9, codes, false)).toBeNull();
    expect(parseCell('T', codes, false)).toBeNull();
  });
});

describe('summarizeMonth', () => {
  it('splits normal, overtime, rest-day and holiday hours', () => {
    const entries = month('9', [
      worked('2026-09-01', '4'), // holiday
      worked('2026-09-02', '11'), // 2h overtime
      worked('2026-09-06', '8'), // Sunday
      status('2026-09-10', 'ABSENT'),
    ]);
    expect(summarizeMonth(september, entries, '9')).toEqual({
      normalHours: `${23 * 9 + 9}.00`,
      overtimeHours: '2.00',
      restDayHours: '8.00',
      holidayHours: '4.00',
      daysWorked: 26,
      workdaysWorked: 24,
      splitDays: 0,
      absentDays: 1,
      leaveDays: 0,
      sickDays: 0,
      travelDays: 0,
      absencesOnDaysOff: 0,
      unrecordedDays: 0,
    });
  });

  it('matches entries to days by date, not by position', () => {
    const entries = month('9', [worked('2026-09-06', '8')]);
    const shuffled = [...entries].reverse();
    expect(summarizeMonth(september, shuffled, '9')).toEqual(summarizeMonth(september, entries, '9'));

    const partial = [worked('2026-09-06', '8'), worked('2026-09-02', '10')];
    expect(summarizeMonth(september, partial, '9')).toMatchObject({
      normalHours: '9.00',
      overtimeHours: '1.00',
      restDayHours: '8.00',
      unrecordedDays: 28,
    });
  });

  it('does not count absences on days off as absence days', () => {
    const entries = [status('2026-09-06', 'SICK'), status('2026-09-01', 'LEAVE'), status('2026-09-07', 'SICK')];
    expect(summarizeMonth(september, entries, '9')).toMatchObject({ sickDays: 1, leaveDays: 0, absencesOnDaysOff: 2 });
  });

  it('rejects entries that do not fit the month or their status', () => {
    expect(() => summarizeMonth(september, [worked('2026-10-01', '9')], '9')).toThrow(/outside the month/);
    expect(() => summarizeMonth(september, [worked('2026-09-02', '9'), status('2026-09-02', 'SICK')], '9')).toThrow(
      /Two entries/,
    );
    expect(() => summarizeMonth(september, [worked('2026-09-02', '0')], '9')).toThrow(RangeError);
    expect(() => summarizeMonth(september, [worked('2026-09-02', '24.5')], '9')).toThrow(RangeError);
    expect(() => summarizeMonth(september, [{ ...status('2026-09-02', 'SICK'), hours: '8' }], '9')).toThrow(
      /has hours/,
    );
  });
});

describe('calculatePay', () => {
  const base = {
    monthlySalary: '7500000',
    workingDays: workingDays(september),
    calendar: september,
    settings,
    travel: null,
  };

  it('pays exactly the monthly salary for every working day at normal hours', () => {
    const result = calculatePay({ ...base, entries: month('9') });
    expect(result.total).toBe('7500000.00');
    expect(result.lines).toEqual([
      { type: 'HOURS', place: 'Site A', kind: 'NORMAL', hours: '225.00', multiplier: '1.00', amount: '7500000.00' },
    ]);
    expect(result.hourlyRate).toEqual({
      monthlySalary: '7500000.00',
      workingDays: { calculated: 25, override: null, effective: 25 },
      normalHoursPerDay: '9.00',
      rounded: '33333.33',
    });

    // Also for salaries whose hourly rate has no exact decimal form.
    const odd = calculatePay({ ...base, monthlySalary: '7777777.77', entries: month('9') });
    expect(odd.lines).toEqual([expect.objectContaining({ kind: 'NORMAL', amount: '7777777.77' })]);
    expect(odd.total).toBe('7777777.77');
  });

  it('pays exact hours: a 4-hour day pays 4 hours', () => {
    const result = calculatePay({ ...base, entries: [worked('2026-09-02', '4')] });
    expect(result.lines).toEqual([
      { type: 'HOURS', place: 'Site A', kind: 'NORMAL', hours: '4.00', multiplier: '1.00', amount: '133333.33' },
    ]);
    expect(result.total).toBe('133333.33');
  });

  it('explains every amount of a mixed month', () => {
    const entries = month('9', [
      worked('2026-09-01', '4'), // holiday
      worked('2026-09-02', '11'), // 2h overtime
      status('2026-09-03', 'SICK'),
      status('2026-09-04', 'LEAVE'),
      status('2026-09-05', 'TRAVEL'),
      worked('2026-09-06', '8'), // Sunday
      worked('2026-09-07', '4'), // short day
      status('2026-09-13', 'SICK'), // Sunday: not an absence day
    ]);
    const result = calculatePay({
      ...base,
      entries,
      travel: { kind: 'PER_DAY_WORKED', routes: { 'Site A': { route: 'Route A', amountPerDay: '20000' } } },
    });

    // Rate = 7 500 000 ÷ (25 × 9) = 33 333.33…
    expect(result.lines).toEqual([
      { type: 'HOURS', place: 'Site A', kind: 'NORMAL', hours: '193.00', multiplier: '1.00', amount: '6433333.33' },
      { type: 'HOURS', place: 'Site A', kind: 'OVERTIME', hours: '2.00', multiplier: '1.50', amount: '100000.00' },
      { type: 'HOURS', place: 'Site A', kind: 'REST_DAY', hours: '8.00', multiplier: '2.00', amount: '533333.33' },
      { type: 'HOURS', place: 'Site A', kind: 'HOLIDAY', hours: '4.00', multiplier: '2.00', amount: '266666.67' },
      {
        type: 'ABSENCE',
        place: 'Site A',
        absence: 'LEAVE',
        days: 1,
        paid: true,
        hoursPerDay: '9.00',
        hoursPerDaySource: 'NORMAL_DAY',
        hours: '9.00',
        amount: '300000.00',
      },
      {
        type: 'ABSENCE',
        place: 'Site A',
        absence: 'SICK',
        days: 1,
        paid: true,
        hoursPerDay: '8.00',
        hoursPerDaySource: 'SETTING',
        hours: '8.00',
        amount: '266666.67',
      },
      {
        type: 'ABSENCE',
        place: 'Site A',
        absence: 'TRAVEL',
        days: 1,
        paid: false,
        hoursPerDay: '9.00',
        hoursPerDaySource: 'NORMAL_DAY',
        hours: '0.00',
        amount: '0.00',
      },
      // Working days only: the holiday and the Sunday worked don't count.
      { type: 'TRAVEL_PER_DAY', place: 'Site A', route: 'Route A', days: 22, amountPerDay: '20000.00', amount: '440000.00' },
    ]);
    expect(result.summary.absencesOnDaysOff).toBe(1);
    expect(result.total).toBe('8340000.00');
  });

  it('uses the admin override of working days for the hourly rate', () => {
    const result = calculatePay({ ...base, workingDays: workingDays(september, 26), entries: month('9') });
    // 7 500 000 × 225 ÷ (26 × 9) = 7 211 538.4615…
    expect(result.lines[0]).toMatchObject({ kind: 'NORMAL', amount: '7211538.46' });
    expect(result.total).toBe('7211538.46');
    expect(result.hourlyRate.rounded).toBe('32051.28');
    expect(result.hourlyRate.workingDays).toEqual({ calculated: 25, override: 26, effective: 26 });
  });

  it('prorates a mid-month hire by the hours worked', () => {
    const entries = september.map((d) =>
      d.day < 16 ? status(d.date, 'NOT_EMPLOYED') : d.kind === 'WORKDAY' ? worked(d.date, '9') : status(d.date, 'OFF'),
    );
    // Sept 16–30 has 13 working days.
    const result = calculatePay({ ...base, entries });
    expect(result.lines).toEqual([
      { type: 'HOURS', place: 'Site A', kind: 'NORMAL', hours: '117.00', multiplier: '1.00', amount: '3900000.00' },
    ]);
  });

  it('adds a monthly travel amount entered by the accountant', () => {
    const result = calculatePay({ ...base, entries: month('9'), travel: { kind: 'MONTHLY_AMOUNT', amount: '350000' } });
    expect(result.lines.at(-1)).toEqual({ type: 'TRAVEL_MONTHLY', amount: '350000.00' });
    expect(result.total).toBe('7850000.00');
  });

  it('rejects settings it cannot pay from', () => {
    const entries = month('9');
    expect(() => calculatePay({ ...base, entries, monthlySalary: '-1' })).toThrow(RangeError);
    expect(() => calculatePay({ ...base, entries, monthlySalary: '100.001' })).toThrow(RangeError);
    expect(() =>
      calculatePay({ ...base, entries, workingDays: { calculated: 25, override: null, effective: 0 } }),
    ).toThrow(RangeError);
    expect(() => calculatePay({ ...base, entries, settings: { ...settings, normalHoursPerDay: '0' } })).toThrow(
      RangeError,
    );
  });
});

describe('a day worked at several places', () => {
  const base = {
    monthlySalary: '7500000',
    workingDays: workingDays(september),
    calendar: september,
    settings,
    travel: null,
  };
  /** Hours lines as [place, kind, hours], to check what each place is charged with. */
  const hoursLines = (entries: DayEntry[]) =>
    calculatePay({ ...base, entries }).lines.flatMap((l) => (l.type === 'HOURS' ? [[l.place, l.kind, l.hours]] : []));

  it('applies the normal hours to the day total and charges overtime to the place entered later', () => {
    // Wednesday 2026-09-02: 6 h at Site A, then 5 h at Site B. 11 h = 9 normal + 2 overtime.
    const entries = [worked('2026-09-02', '6', 'Site A', 1), worked('2026-09-02', '5', 'Site B', 2)];
    expect(summarizeMonth(september, entries, '9')).toMatchObject({
      normalHours: '9.00',
      overtimeHours: '2.00',
      daysWorked: 1,
      workdaysWorked: 1,
      splitDays: 1,
    });
    expect(hoursLines(entries)).toEqual([
      ['Site A', 'NORMAL', '6.00'],
      ['Site B', 'NORMAL', '3.00'],
      ['Site B', 'OVERTIME', '2.00'],
    ]);
    // The order of entry is seq, not the order the caller lists them in.
    expect(hoursLines([...entries].reverse())).toEqual(hoursLines(entries));
    // Site A entered later: Site A gets the overtime.
    expect(hoursLines([worked('2026-09-02', '6', 'Site A', 2), worked('2026-09-02', '5', 'Site B', 1)])).toEqual([
      ['Site A', 'NORMAL', '4.00'],
      ['Site B', 'NORMAL', '5.00'],
      ['Site A', 'OVERTIME', '2.00'],
    ]);
  });

  it('charges overtime the later place did not work to the place before it', () => {
    // 10 h at Site A, then 2 h at Site B: 3 h overtime, but Site B has only 2.
    expect(hoursLines([worked('2026-09-02', '10', 'Site A', 1), worked('2026-09-02', '2', 'Site B', 2)])).toEqual([
      ['Site A', 'NORMAL', '9.00'],
      ['Site A', 'OVERTIME', '1.00'],
      ['Site B', 'OVERTIME', '2.00'],
    ]);
  });

  it('charges each place its own hours on rest days and holidays', () => {
    const entries = [
      worked('2026-09-06', '5', 'Site A', 1), // Sunday
      worked('2026-09-06', '6', 'Site B', 2),
      worked('2026-09-01', '3', 'Site B', 7), // holiday
      worked('2026-09-01', '2', 'Site A', 8),
    ];
    expect(hoursLines(entries)).toEqual([
      ['Site A', 'REST_DAY', '5.00'],
      ['Site B', 'REST_DAY', '6.00'],
      ['Site A', 'HOLIDAY', '2.00'],
      ['Site B', 'HOLIDAY', '3.00'],
    ]);
    expect(summarizeMonth(september, entries, '9')).toMatchObject({ daysWorked: 2, workdaysWorked: 0, splitDays: 2 });
  });

  it('pays a full month split across sites like any other month, explaining each site share', () => {
    const entries = month('9', [worked('2026-09-02', '4', 'Site A', 1), worked('2026-09-02', '7', 'Site B', 2)]);
    const result = calculatePay({ ...base, entries });
    expect(result.lines).toEqual([
      { type: 'HOURS', place: 'Site A', kind: 'NORMAL', hours: '220.00', multiplier: '1.00', amount: '7333333.33' },
      { type: 'HOURS', place: 'Site B', kind: 'NORMAL', hours: '5.00', multiplier: '1.00', amount: '166666.67' },
      { type: 'HOURS', place: 'Site B', kind: 'OVERTIME', hours: '2.00', multiplier: '1.50', amount: '100000.00' },
    ]);
    expect(result.total).toBe('7600000.00');
  });

  it('counts a split day once for travel pay, at the route of the place entered later', () => {
    const entries = [
      worked('2026-09-02', '4', 'Site A', 1),
      worked('2026-09-02', '5', 'Site B', 2),
      worked('2026-09-03', '9', 'Site A', 3),
      worked('2026-09-06', '4', 'Site A', 4), // Sunday: no travel pay
      worked('2026-09-06', '4', 'Site B', 5),
    ];
    const routes = {
      'Site A': { route: 'Route A', amountPerDay: '20000' },
      'Site B': { route: 'Route B', amountPerDay: '30000' },
    };
    const travelLines = (travel: TravelInput) =>
      calculatePay({ ...base, entries, travel }).lines.filter((l) => l.type === 'TRAVEL_PER_DAY');

    expect(travelLines({ kind: 'PER_DAY_WORKED', routes })).toEqual([
      { type: 'TRAVEL_PER_DAY', place: 'Site A', route: 'Route A', days: 1, amountPerDay: '20000.00', amount: '20000.00' },
      { type: 'TRAVEL_PER_DAY', place: 'Site B', route: 'Route B', days: 1, amountPerDay: '30000.00', amount: '30000.00' },
    ]);
    // No route at the later site: the day is shown and pays nothing.
    expect(travelLines({ kind: 'PER_DAY_WORKED', routes: { ...routes, 'Site B': null } })[1]).toEqual({
      type: 'TRAVEL_PER_DAY',
      place: 'Site B',
      route: null,
      days: 1,
      amountPerDay: '0.00',
      amount: '0.00',
    });
    expect(() => travelLines({ kind: 'PER_DAY_WORKED', routes: { 'Site A': routes['Site A'] } })).toThrow(
      /No travel route given for Site B/,
    );
  });

  it('charges an absence to the place it was recorded at', () => {
    const result = calculatePay({ ...base, entries: [status('2026-09-02', 'SICK', 'Site B')] });
    expect(result.lines[0]).toMatchObject({ type: 'ABSENCE', place: 'Site B', absence: 'SICK', days: 1 });
  });

  it('rejects days that cannot be split', () => {
    const summarize = (entries: DayEntry[]) => () => summarizeMonth(september, entries, '9');
    expect(summarize([worked('2026-09-02', '4', 'Site A', 1), worked('2026-09-02', '5', 'Site A', 2)])).toThrow(
      /Two entries for 2026-09-02 at Site A/,
    );
    expect(summarize([worked('2026-09-02', '4', 'Site A', 1), worked('2026-09-02', '5', 'Site B', 1)])).toThrow(
      /same seq/,
    );
    // An absence or a day off is the whole day.
    const sick = { ...status('2026-09-02', 'SICK', 'Site B'), seq: 2 };
    expect(summarize([worked('2026-09-02', '4', 'Site A', 1), sick])).toThrow(/not all of them are hours worked/);
    expect(summarize([worked('2026-09-02', '20', 'Site A', 1), worked('2026-09-02', '4.01', 'Site B', 2)])).toThrow(
      /More than 24 hours on 2026-09-02/,
    );
    expect(summarize([worked('2026-09-02', '20', 'Site A', 1), worked('2026-09-02', '4', 'Site B', 2)])).not.toThrow();
    expect(summarize([worked('2026-09-02', '4', '', 1)])).toThrow(/no place/);
    expect(summarize([worked('2026-09-02', '4', 'Site A', 1.5)])).toThrow(/invalid seq/);
  });
});

describe('monthly totals', () => {
  const base = {
    monthlySalary: '7500000',
    workingDays: workingDays(september),
    calendar: september,
    settings,
    travel: null,
  };
  const at = (totals: MonthlyTotals, place = 'Site A') => [{ place, totals }];
  const FULL: MonthlyTotals = {
    normalHours: '225',
    overtimeHours: '0',
    restDayHours: '0',
    holidayHours: '0',
    workdaysWorked: 25,
    leaveDays: 0,
    sickDays: 0,
    travelDays: 0,
  };

  it('pays exactly the monthly salary for a full month at normal hours, and says the hours are totals', () => {
    const result = calculatePay({ ...base, totals: at(FULL) });
    expect(result.source).toBe('TOTALS');
    expect(result.totals).toEqual(at(FULL));
    expect(result.total).toBe('7500000.00');
  });

  it('pays the same lines as the daily entries the totals sum up', () => {
    const entries = month('9', [
      worked('2026-09-01', '4'), // holiday
      worked('2026-09-02', '11'), // 2h overtime
      status('2026-09-03', 'SICK'),
      status('2026-09-04', 'LEAVE'),
      status('2026-09-05', 'TRAVEL'),
      worked('2026-09-06', '8'), // Sunday
      worked('2026-09-07', '4'), // short day
    ]);
    const travel: TravelInput = { kind: 'PER_DAY_WORKED', routes: { 'Site A': { route: 'Route A', amountPerDay: '20000' } } };
    const daily = calculatePay({ ...base, entries, travel });
    const sum = daily.summary;
    const totals: MonthlyTotals = {
      normalHours: sum.normalHours,
      overtimeHours: sum.overtimeHours,
      restDayHours: sum.restDayHours,
      holidayHours: sum.holidayHours,
      workdaysWorked: sum.workdaysWorked,
      leaveDays: sum.leaveDays,
      sickDays: sum.sickDays,
      travelDays: sum.travelDays,
    };
    expect(checkTotals(at(totals), september, '9')).toEqual([]);
    const fromTotals = calculatePay({ ...base, totals: at(totals), travel });
    expect(fromTotals.lines).toEqual(daily.lines);
    expect(fromTotals.total).toBe(daily.total);
  });

  it('finds totals that cannot fit the month', () => {
    const problems = (totals: MonthlyTotals) => checkTotals(at(totals), september, '9').map((i) => i.problem);
    expect(problems({ ...FULL, normalHours: '226' })).toEqual(['NORMAL_ABOVE_DAYS_WORKED']);
    expect(problems({ ...FULL, workdaysWorked: 0, normalHours: '0', overtimeHours: '3' })).toEqual([
      'WORKDAY_HOURS_ABOVE_DAYS_WORKED',
    ]);
    expect(problems({ ...FULL, sickDays: 1 })).toEqual(['DAYS_ABOVE_WORKING_DAYS']);
    // September 2026 has 4 Sundays and 1 holiday.
    expect(problems({ ...FULL, restDayHours: '96' })).toEqual([]);
    expect(problems({ ...FULL, restDayHours: '96.5', holidayHours: '24.5' })).toEqual([
      'REST_DAY_HOURS_ABOVE_REST_DAYS',
      'HOLIDAY_HOURS_ABOVE_HOLIDAYS',
    ]);
    expect(() => calculatePay({ ...base, totals: at({ ...FULL, normalHours: '226' }) })).toThrow(/NORMAL_ABOVE_DAYS_WORKED/);
    expect(() => checkTotals(at({ ...FULL, sickDays: -1 }), september, '9')).toThrow(RangeError);
    expect(() => checkTotals(at({ ...FULL, normalHours: '1.005' }), september, '9')).toThrow(RangeError);
  });

  it('checks two placements of one month each and together', () => {
    const half = { ...FULL, normalHours: '117', workdaysWorked: 13 };
    const list = [
      { place: 'Placement 1', totals: half },
      { place: 'Placement 2', totals: { ...half, normalHours: '200' } },
    ];
    // Placement 2: 200 h > 13 days × 9 h. Together: 317 h > 26 days × 9 h, and 26 days worked > 25 working days.
    expect(checkTotals(list, september, '9')).toEqual([
      { place: 'Placement 2', problem: 'NORMAL_ABOVE_DAYS_WORKED' },
      { place: null, problem: 'NORMAL_ABOVE_DAYS_WORKED' },
      { place: null, problem: 'DAYS_ABOVE_WORKING_DAYS' },
    ]);
    const ok = calculatePay({
      ...base,
      totals: [
        { place: 'Placement 1', totals: { ...FULL, normalHours: '117', workdaysWorked: 13 } },
        { place: 'Placement 2', totals: { ...FULL, normalHours: '108', workdaysWorked: 12 } },
      ],
    });
    // Two placements under the same rules add up to exactly the salary.
    expect(ok.lines.map((l) => (l.type === 'HOURS' ? [l.place, l.hours] : l.type))).toEqual([
      ['Placement 1', '117.00'],
      ['Placement 2', '108.00'],
    ]);
    expect(ok.total).toBe('7500000.00');
  });

  it('adds up a month paid in parts without rounding them on their own', () => {
    // Half the month under 9-hour days, the rest under 8-hour days.
    const first = calculatePay({ ...base, totals: at({ ...FULL, normalHours: '100', workdaysWorked: 12 }) });
    const second = calculatePay({
      ...base,
      settings: { ...settings, normalHoursPerDay: '8' },
      totals: at({ ...FULL, normalHours: '95', workdaysWorked: 12 }, 'Site B'),
    });
    // 100 h × 7 500 000 ÷ 225 = 3 333 333.33; 95 h × 7 500 000 ÷ 200 = 3 562 500
    expect([first.total, second.total]).toEqual(['3333333.33', '3562500.00']);
    // Rounded once: 6 895 833.33 → 6 896 000
    expect(payOut([first, second], [], '1000')).toEqual({
      earned: '6895833.33',
      adjustments: [],
      rounding: { step: '1000.00', amount: '166.67' },
      total: '6896000.00',
    });
  });
});

describe('payOut', () => {
  const base = { monthlySalary: '7500000', workingDays: workingDays(september), calendar: september, settings };
  const earned = (amount: string) => calculatePay({ ...base, entries: [], travel: { kind: 'MONTHLY_AMOUNT', amount } });

  it('adds bonuses and takes off advances and deductions, then rounds once', () => {
    const result = payOut(
      [earned('7500000')],
      [
        { id: 'b', type: 'BONUS', amount: '500000' },
        { id: 'a', type: 'ADVANCE', amount: '2000000' },
        { id: 'd', type: 'DEDUCTION', amount: '123456.78' },
      ],
      '1000',
    );
    expect(result).toEqual({
      earned: '7500000.00',
      adjustments: [
        { id: 'b', type: 'BONUS', amount: '500000.00' },
        { id: 'a', type: 'ADVANCE', amount: '-2000000.00' },
        { id: 'd', type: 'DEDUCTION', amount: '-123456.78' },
      ],
      // 5 876 543.22 → 5 877 000
      rounding: { step: '1000.00', amount: '456.78' },
      total: '5877000.00',
    });
  });

  it('rounds to the nearest step, halves up, with no rounding line when nothing changes', () => {
    const total = (amount: string, step = '1000') => payOut([earned(amount)], [], step);
    expect(total('333.33').total).toBe('0.00');
    expect(total('300000')).toMatchObject({ rounding: null, total: '300000.00' });
    expect(total('500')).toMatchObject({ rounding: { step: '1000.00', amount: '500.00' }, total: '1000.00' });
    expect(total('499.99').total).toBe('0.00');
    expect(total('133333.33', '0.01')).toMatchObject({ rounding: null, total: '133333.33' });
    expect(() => total('9', '0')).toThrow(RangeError);
  });

  it('goes below zero when advances exceed what was earned: the worker owes it', () => {
    const result = payOut([earned('1000000')], [{ id: 'a', type: 'ADVANCE', amount: '1500500' }], '1000');
    // −500 500 → −501 000 (halves away from zero)
    expect(result).toMatchObject({ rounding: { amount: '-500.00' }, total: '-501000.00' });
  });

  it('refuses amounts that are not positive', () => {
    expect(() => payOut([earned('1')], [{ id: 'a', type: 'BONUS', amount: '0' }], '1000')).toThrow(RangeError);
    expect(() => payOut([earned('1')], [{ id: 'a', type: 'BONUS', amount: '-5' }], '1000')).toThrow(RangeError);
  });
});
