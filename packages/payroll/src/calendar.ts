/** Kind of calendar day, independent of what any worker did on it. */
export type DayKind = 'WORKDAY' | 'REST_DAY' | 'HOLIDAY';

export interface CalendarDay {
  /** ISO date, e.g. "2026-09-01". */
  date: string;
  /** Day of month, 1-based. */
  day: number;
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  weekday: number;
  kind: DayKind;
}

export interface CalendarOptions {
  /** ISO weekdays that are rest days. Construction sites usually rest only on Sunday. */
  restWeekdays?: number[];
  /** ISO dates of official holidays. */
  holidays?: string[];
}

/** Builds the list of days for a month. `month` is 1-based. */
export function buildMonthCalendar(
  year: number,
  month: number,
  { restWeekdays = [7], holidays = [] }: CalendarOptions = {},
): CalendarDay[] {
  const holidaySet = new Set(holidays);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days: CalendarDay[] = [];

  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(Date.UTC(year, month - 1, day));
    const date = d.toISOString().slice(0, 10);
    const weekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    const kind: DayKind = holidaySet.has(date)
      ? 'HOLIDAY'
      : restWeekdays.includes(weekday)
        ? 'REST_DAY'
        : 'WORKDAY';
    days.push({ date, day, weekday, kind });
  }
  return days;
}

export function countWorkdays(calendar: CalendarDay[]): number {
  return calendar.filter((d) => d.kind === 'WORKDAY').length;
}
