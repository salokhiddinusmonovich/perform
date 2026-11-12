import type { CalendarDay } from './calendar.js';

/** A worker's monthly salary from a day on, until their next one (AGENTS.md: Salaries). */
export interface SalaryFrom {
  /** ISO date */
  from: string;
  /** Decimal string */
  monthlySalary: string;
}

/**
 * Days of a month paid at one salary, as one part: the hourly rate is the salary over the
 * whole month's working days and normal hours, so a full month split only by a salary
 * change pays each salary for its share of the month.
 */
export interface SalarySpan {
  /** First and last day, ISO dates */
  from: string;
  until: string;
  /** null: no salary on these days yet (they are before the first one) */
  monthlySalary: string | null;
  /** The day the span's salary started; null without one */
  since: string | null;
}

/**
 * Splits a month into spans of one salary each. The first span starts on the month's
 * first day with the salary in force then (the latest one from that day or earlier, or
 * none); each salary starting later in the month starts a new span. Two spans in a row
 * with the same amount are one (nothing about the pay changes between them).
 */
export function salarySpans(calendar: readonly CalendarDay[], salaries: readonly SalaryFrom[]): SalarySpan[] {
  if (calendar.length === 0) throw new RangeError('The month has no days');
  const first = calendar[0].date;
  const last = calendar[calendar.length - 1].date;
  const sorted = [...salaries].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  sorted.forEach((s, i) => {
    if (i > 0 && s.from === sorted[i - 1].from) throw new RangeError(`Two salaries from ${s.from}`);
  });

  const spans: SalarySpan[] = [];
  const start = (from: string, salary: SalaryFrom | null) => {
    const previous = spans.at(-1);
    if (previous && previous.monthlySalary === (salary?.monthlySalary ?? null)) return;
    if (previous) previous.until = calendar[calendar.findIndex((d) => d.date === from) - 1].date;
    spans.push({ from, until: last, monthlySalary: salary?.monthlySalary ?? null, since: salary?.from ?? null });
  };
  start(first, sorted.filter((s) => s.from <= first).at(-1) ?? null);
  for (const s of sorted) {
    if (s.from > first && s.from <= last) start(s.from, s);
  }
  return spans;
}

/**
 * The days two splits of one month have in common: every pair of spans that overlap, with
 * the days both cover, in day order. Splitting a month by shift and by salary gives its
 * parts.
 */
export function overlapSpans<A extends { from: string; until: string }, B extends { from: string; until: string }>(
  a: readonly A[],
  b: readonly B[],
): { from: string; until: string; a: A; b: B }[] {
  const out: { from: string; until: string; a: A; b: B }[] = [];
  for (const x of a) {
    for (const y of b) {
      const from = x.from > y.from ? x.from : y.from;
      const until = x.until < y.until ? x.until : y.until;
      if (from <= until) out.push({ from, until, a: x, b: y });
    }
  }
  return out.sort((p, q) => (p.from < q.from ? -1 : p.from > q.from ? 1 : 0));
}
