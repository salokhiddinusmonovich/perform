/** Kind of calendar day, independent of what any worker did on it. */
export type DayKind = 'WORKDAY' | 'REST_DAY' | 'HOLIDAY';

export interface CalendarDay {
  /** ISO date, e.g. "2026-09-01". */
  date: string;
  /** Day of month, 1-based. */
  day: number;
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  weekday: number;
  /** A holiday that falls on a rest weekday is a HOLIDAY. */
  kind: DayKind;
}

export interface CalendarOptions {
  /** ISO weekdays that are rest days (Settings). */
  restWeekdays: readonly number[];
  /** ISO dates of public holidays and company days off. */
  holidays: readonly string[];
  /**
   * ISO dates that are working days although they fall on a rest weekday: the
   * other half of a day-off swap the government declares. On a weekday that
   * isn't a rest day (e.g. at a site with other rest days) it changes nothing.
   */
  extraWorkdays?: readonly string[];
}

/** Builds the list of days for a month. `month` is 1-based. */
export function buildMonthCalendar(
  year: number,
  month: number,
  { restWeekdays, holidays, extraWorkdays = [] }: CalendarOptions,
): CalendarDay[] {
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new RangeError(`Invalid month ${month}`);
  if (restWeekdays.some((w) => !Number.isInteger(w) || w < 1 || w > 7)) {
    throw new RangeError(`Rest weekdays must be ISO weekdays 1–7, got ${restWeekdays.join(',')}`);
  }
  const holidaySet = new Set(holidays);
  const extraWorkdaySet = new Set(extraWorkdays);
  const clash = holidays.find((d) => extraWorkdaySet.has(d));
  if (clash) throw new RangeError(`${clash} can't be both a holiday and a working day`);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days: CalendarDay[] = [];

  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(Date.UTC(year, month - 1, day));
    const date = d.toISOString().slice(0, 10);
    const weekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    const kind: DayKind = holidaySet.has(date)
      ? 'HOLIDAY'
      : restWeekdays.includes(weekday) && !extraWorkdaySet.has(date)
        ? 'REST_DAY'
        : 'WORKDAY';
    days.push({ date, day, weekday, kind });
  }
  return days;
}

export function countWorkdays(calendar: readonly CalendarDay[]): number {
  return calendar.filter((d) => d.kind === 'WORKDAY').length;
}

/**
 * Working days in a month: calculated from the calendar, with an optional
 * admin override for that month. Both are kept so the app can show them side
 * by side and every pay line can say which one it used.
 */
export interface WorkingDays {
  calculated: number;
  /** Set by an admin for this month; null when the calculated value is used. */
  override: number | null;
  /** The value pay is based on: the override if set, else the calculated one. */
  effective: number;
}

export function workingDays(calendar: readonly CalendarDay[], override: number | null = null): WorkingDays {
  if (override !== null && (!Number.isInteger(override) || override < 1 || override > calendar.length)) {
    throw new RangeError(`Working days override must be 1–${calendar.length}, got ${override}`);
  }
  const calculated = countWorkdays(calendar);
  return { calculated, override, effective: override ?? calculated };
}
