import type { CalendarDay } from './calendar.js';

/**
 * A worker's shift from a day on, until their next one (AGENTS.md: Shifts). `shift` is
 * the caller's key for the shift, or null: no shift from that day, so the rule set's
 * normal hours apply.
 */
export interface ShiftFrom {
  /** ISO date */
  from: string;
  shift: string | null;
}

/**
 * Days of a month on one shift, paid as one part: their normal hours per day are the
 * shift's (the hourly rate, the overtime threshold, absence hours that follow normal
 * hours), while working days stay the rule set's for the whole month. So a full month
 * split only by shift still pays exactly the salary.
 */
export interface ShiftSpan {
  /** First and last day, ISO dates */
  from: string;
  until: string;
  shift: string | null;
}

/**
 * Splits a month into spans of one shift each. The first span starts on the month's
 * first day with the shift in force then (the latest one from that day or earlier, or
 * none); each shift starting later in the month starts a new span. Two spans in a row
 * with the same shift are one (nothing about the pay changes between them).
 */
export function shiftSpans(calendar: readonly CalendarDay[], shifts: readonly ShiftFrom[]): ShiftSpan[] {
  if (calendar.length === 0) throw new RangeError('The month has no days');
  const first = calendar[0].date;
  const last = calendar[calendar.length - 1].date;
  const sorted = [...shifts].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  sorted.forEach((s, i) => {
    if (i > 0 && s.from === sorted[i - 1].from) throw new RangeError(`Two shifts from ${s.from}`);
  });

  const spans: ShiftSpan[] = [];
  const start = (from: string, shift: string | null) => {
    const previous = spans.at(-1);
    if (previous?.shift === shift) return;
    if (previous) previous.until = calendar[calendar.findIndex((d) => d.date === from) - 1].date;
    spans.push({ from, until: last, shift });
  };
  start(first, sorted.filter((s) => s.from <= first).at(-1)?.shift ?? null);
  for (const s of sorted) {
    if (s.from > first && s.from <= last) start(s.from, s.shift);
  }
  return spans;
}

/** The calendar days of a span: a part's own calendar for calculatePay and checkTotals. */
export function spanCalendar(calendar: readonly CalendarDay[], span: Pick<ShiftSpan, 'from' | 'until'>): CalendarDay[] {
  return calendar.filter((d) => d.date >= span.from && d.date <= span.until);
}
