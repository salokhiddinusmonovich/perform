import type { CalendarDay } from './calendar';
import { fromUnits, toUnits, type Units } from './decimal';
import { MAX_HOURS_PER_DAY, type DayEntry } from './entry';

/** Kinds of worked hours; each has its own pay multiplier in Settings. */
export type HourKind = 'NORMAL' | 'OVERTIME' | 'REST_DAY' | 'HOLIDAY';
export const HOUR_KINDS: readonly HourKind[] = ['NORMAL', 'OVERTIME', 'REST_DAY', 'HOLIDAY'];

/** Absence types whose pay is set in Settings. */
export type AbsenceType = 'LEAVE' | 'SICK' | 'TRAVEL';
export const ABSENCE_TYPES: readonly AbsenceType[] = ['LEAVE', 'SICK', 'TRAVEL'];

export interface HoursSummary {
  /** Hours on working days up to the normal hours per day (decimal string). */
  normalHours: string;
  /** Hours on working days above the normal hours per day. */
  overtimeHours: string;
  /** Hours on rest weekdays. */
  restDayHours: string;
  /** Hours on public holidays and company days off. */
  holidayHours: string;
  /** Days with hours worked, of any kind. */
  daysWorked: number;
  /** Working days with hours worked (rest days and holidays not counted). */
  workdaysWorked: number;
  /** Absence days on working days, per status. */
  absentDays: number;
  leaveDays: number;
  sickDays: number;
  travelDays: number;
  /**
   * Absences (ABSENT, LEAVE, SICK, TRAVEL) recorded on rest days or holidays.
   * Nobody was due at work those days, so they are not absence days and are
   * not paid; they are counted so the result explains where they went.
   */
  absencesOnDaysOff: number;
  /** Days of the month with no entry at all. */
  unrecordedDays: number;
}

/** The same summary in hundredths, for calculations. */
export interface HoursUnits {
  hours: Record<HourKind, Units>;
  absenceDays: Record<AbsenceType, number>;
  summary: HoursSummary;
}

/**
 * Splits a worker's month into hour buckets. Entries are matched to calendar
 * days by date; an entry for a date outside the month, two entries for one day,
 * or hours that don't fit the status are errors. Pay policy (rates, multipliers,
 * which absences are paid) is applied on top of this, in calculatePay.
 */
export function summarizeMonth(
  calendar: readonly CalendarDay[],
  entries: readonly DayEntry[],
  normalHoursPerDay: string,
): HoursSummary {
  return summarizeUnits(calendar, entries, toUnits(normalHoursPerDay, 'normalHoursPerDay')).summary;
}

export function summarizeUnits(
  calendar: readonly CalendarDay[],
  entries: readonly DayEntry[],
  normalDay: Units,
): HoursUnits {
  if (normalDay <= 0n || normalDay > BigInt(MAX_HOURS_PER_DAY) * 100n) {
    throw new RangeError(`Normal hours per day must be more than 0 and at most ${MAX_HOURS_PER_DAY}`);
  }
  const days = new Map(calendar.map((d) => [d.date, d]));
  const seen = new Set<string>();
  const hours: Record<HourKind, Units> = { NORMAL: 0n, OVERTIME: 0n, REST_DAY: 0n, HOLIDAY: 0n };
  const absenceDays: Record<AbsenceType, number> = { LEAVE: 0, SICK: 0, TRAVEL: 0 };
  let daysWorked = 0;
  let workdaysWorked = 0;
  let absentDays = 0;
  let absencesOnDaysOff = 0;

  for (const e of entries) {
    const day = days.get(e.date);
    if (!day) throw new RangeError(`Entry for ${e.date} is outside the month`);
    if (seen.has(e.date)) throw new RangeError(`Two entries for ${e.date}`);
    seen.add(e.date);

    const h = toUnits(e.hours, `hours on ${e.date}`);
    if (e.status === 'WORKED') {
      if (h <= 0n || h > BigInt(MAX_HOURS_PER_DAY) * 100n) {
        throw new RangeError(`Hours on ${e.date} must be more than 0 and at most ${MAX_HOURS_PER_DAY}`);
      }
    } else if (h !== 0n) {
      throw new RangeError(`Entry on ${e.date} has hours but status ${e.status}`);
    }

    switch (e.status) {
      case 'WORKED':
        daysWorked++;
        if (day.kind === 'WORKDAY') {
          workdaysWorked++;
          hours.NORMAL += h < normalDay ? h : normalDay;
          hours.OVERTIME += h > normalDay ? h - normalDay : 0n;
        } else if (day.kind === 'REST_DAY') {
          hours.REST_DAY += h;
        } else {
          hours.HOLIDAY += h;
        }
        break;
      case 'ABSENT':
      case 'LEAVE':
      case 'SICK':
      case 'TRAVEL':
        if (day.kind !== 'WORKDAY') absencesOnDaysOff++;
        else if (e.status === 'ABSENT') absentDays++;
        else absenceDays[e.status]++;
        break;
      case 'OFF':
      case 'NOT_EMPLOYED':
        break;
    }
  }

  return {
    hours,
    absenceDays,
    summary: {
      normalHours: fromUnits(hours.NORMAL),
      overtimeHours: fromUnits(hours.OVERTIME),
      restDayHours: fromUnits(hours.REST_DAY),
      holidayHours: fromUnits(hours.HOLIDAY),
      daysWorked,
      workdaysWorked,
      absentDays,
      leaveDays: absenceDays.LEAVE,
      sickDays: absenceDays.SICK,
      travelDays: absenceDays.TRAVEL,
      absencesOnDaysOff,
      unrecordedDays: calendar.length - seen.size,
    },
  };
}
