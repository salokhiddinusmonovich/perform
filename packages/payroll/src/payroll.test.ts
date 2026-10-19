import { describe, expect, it } from 'vitest';
import { buildMonthCalendar, countWorkdays } from './calendar';
import { parseCell } from './entry';
import { summarizeMonth } from './summary';

// September 2026: Sept 1 (Tue) is Independence Day, Sundays are 6/13/20/27.
const september = buildMonthCalendar(2026, 9, { holidays: ['2026-09-01'] });

describe('buildMonthCalendar', () => {
  it('has 25 workdays in September 2026', () => {
    expect(september).toHaveLength(30);
    expect(countWorkdays(september)).toBe(25);
  });

  it('marks holidays and Sundays', () => {
    expect(september[0]).toMatchObject({ date: '2026-09-01', weekday: 2, kind: 'HOLIDAY' });
    expect(september[5]).toMatchObject({ date: '2026-09-06', weekday: 7, kind: 'REST_DAY' });
  });
});

describe('parseCell', () => {
  it('reads hours and codes used in the sample files', () => {
    expect(parseCell(12)).toEqual({ status: 'WORKED', hours: 12 });
    expect(parseCell('9')).toEqual({ status: 'WORKED', hours: 9 });
    expect(parseCell('T')?.status).toBe('OFF');
    expect(parseCell('Y')?.status).toBe('ABSENT');
    expect(parseCell('iz')?.status).toBe('LEAVE');
    expect(parseCell('İ')?.status).toBe('LEAVE');
    expect(parseCell('-')?.status).toBe('NOT_EMPLOYED');
  });

  it('returns null for unknown codes', () => {
    expect(parseCell('???')).toBeNull();
  });
});

describe('summarizeMonth', () => {
  it('splits normal, overtime and rest-day hours', () => {
    const entries = september.map((d) => {
      if (d.date === '2026-09-06') return parseCell(8)!; // worked a Sunday
      if (d.date === '2026-09-10') return parseCell('Y')!;
      if (d.kind !== 'WORKDAY') return parseCell('T')!;
      return parseCell(d.day % 2 ? 11 : 9)!;
    });
    const s = summarizeMonth(september, entries, 9);

    expect(s.daysWorked).toBe(24);
    expect(s.normalHours).toBe(24 * 9);
    expect(s.restDayHours).toBe(8);
    expect(s.absentDays).toBe(1);
    // Odd-numbered workdays get 2h overtime; Sept 1 is a holiday.
    const oddWorkdays = september.filter(
      (d) => d.kind === 'WORKDAY' && d.day % 2 === 1,
    ).length;
    expect(s.overtimeHours).toBe(oddWorkdays * 2);
  });
});
