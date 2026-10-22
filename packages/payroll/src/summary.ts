import type { CalendarDay } from './calendar';
import { fromUnits, toUnits, type Units } from './decimal';
import { MAX_HOURS_PER_DAY, type DayEntry } from './entry';

/** Kinds of worked hours; each has its own pay multiplier in Settings. */
export type HourKind = 'NORMAL' | 'OVERTIME' | 'REST_DAY' | 'HOLIDAY';
export const HOUR_KINDS: readonly HourKind[] = ['NORMAL', 'OVERTIME', 'REST_DAY', 'HOLIDAY'];

/** Absence types whose pay is set in Settings. */
export type AbsenceType = 'LEAVE' | 'SICK' | 'TRAVEL';
export const ABSENCE_TYPES: readonly AbsenceType[] = ['LEAVE', 'SICK', 'TRAVEL'];

/** The worker's month, all places together. */
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
  /** Days with hours worked at two or more places (sites or teams). */
  splitDays: number;
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

/** What one place (site or team) is charged with, hours in hundredths. */
export interface PlaceUnits {
  hours: Record<HourKind, Units>;
  /** Absence days on working days recorded at this place. */
  absenceDays: Record<AbsenceType, number>;
  /**
   * Working days worked whose travel pay goes to this place: on a split day,
   * only the place entered last, so the day counts once.
   */
  travelDays: number;
}

/** The month per place, for calculations. */
export interface HoursUnits {
  /** Keyed by DayEntry.place, in sorted order. */
  places: ReadonlyMap<string, PlaceUnits>;
  summary: HoursSummary;
}

const MAX_DAY = BigInt(MAX_HOURS_PER_DAY) * 100n;

/**
 * Splits a worker's month into hour buckets. Entries are matched to calendar
 * days by date; pay policy (rates, multipliers, which absences are paid) is
 * applied on top of this, in calculatePay.
 *
 * A worker may work at several places on one day, one entry per place. The
 * normal hours per day apply to the day's total and are filled in the order the
 * entries were entered (DayEntry.seq), so the hours above them, the overtime,
 * are charged to the place entered later. If that place has fewer hours than
 * the overtime, the rest is charged to the place entered before it, and so on.
 * Travel pay counts such a day once, for the place entered last.
 *
 * Errors: an entry outside the month, two entries for one place and day, two
 * entries of one day with the same seq, hours that don't fit the status, more
 * than 24 hours in a day, or a day with several entries that are not all WORKED
 * (an absence or a day off is the worker's whole day).
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
  if (normalDay <= 0n || normalDay > MAX_DAY) {
    throw new RangeError(`Normal hours per day must be more than 0 and at most ${MAX_HOURS_PER_DAY}`);
  }
  const days = new Map(calendar.map((d) => [d.date, d]));
  const byDate = new Map<string, DayEntry[]>();
  for (const e of entries) {
    if (!days.has(e.date)) throw new RangeError(`Entry for ${e.date} is outside the month`);
    if (e.place === '') throw new RangeError(`Entry for ${e.date} has no place`);
    if (!Number.isSafeInteger(e.seq)) throw new RangeError(`Entry for ${e.date} has an invalid seq`);
    const list = byDate.get(e.date);
    if (list) list.push(e);
    else byDate.set(e.date, [e]);
  }

  const places = new Map<string, PlaceUnits>();
  const at = (key: string): PlaceUnits => {
    let p = places.get(key);
    if (!p) {
      p = {
        hours: { NORMAL: 0n, OVERTIME: 0n, REST_DAY: 0n, HOLIDAY: 0n },
        absenceDays: { LEAVE: 0, SICK: 0, TRAVEL: 0 },
        travelDays: 0,
      };
      places.set(key, p);
    }
    return p;
  };
  const total: Record<HourKind, Units> = { NORMAL: 0n, OVERTIME: 0n, REST_DAY: 0n, HOLIDAY: 0n };
  const absenceDays: Record<AbsenceType, number> = { LEAVE: 0, SICK: 0, TRAVEL: 0 };
  let daysWorked = 0;
  let workdaysWorked = 0;
  let splitDays = 0;
  let absentDays = 0;
  let absencesOnDaysOff = 0;

  for (const [date, dayEntries] of byDate) {
    const day = days.get(date)!;
    // Oldest first: the order the entries were entered in.
    const sorted = [...dayEntries].sort((a, b) => a.seq - b.seq);
    const seenPlaces = new Set<string>();
    sorted.forEach((e, i) => {
      if (seenPlaces.has(e.place)) throw new RangeError(`Two entries for ${date} at ${e.place}`);
      seenPlaces.add(e.place);
      if (i > 0 && e.seq === sorted[i - 1].seq) throw new RangeError(`Two entries for ${date} with the same seq`);
    });
    const hours = sorted.map(checkedHours);
    if (sorted.length > 1 && sorted.some((e) => e.status !== 'WORKED')) {
      throw new RangeError(`Two entries for ${date}, but not all of them are hours worked`);
    }

    const first = sorted[0];
    switch (first.status) {
      case 'WORKED': {
        const dayTotal = hours.reduce((sum, h) => sum + h, 0n);
        if (dayTotal > MAX_DAY) throw new RangeError(`More than ${MAX_HOURS_PER_DAY} hours on ${date}`);
        daysWorked++;
        if (sorted.length > 1) splitDays++;
        if (day.kind === 'WORKDAY') {
          workdaysWorked++;
          let normalLeft = normalDay;
          sorted.forEach((e, i) => {
            const normal = hours[i] < normalLeft ? hours[i] : normalLeft;
            normalLeft -= normal;
            at(e.place).hours.NORMAL += normal;
            at(e.place).hours.OVERTIME += hours[i] - normal;
          });
          total.NORMAL += normalDay - normalLeft;
          total.OVERTIME += dayTotal - (normalDay - normalLeft);
          at(sorted[sorted.length - 1].place).travelDays++;
        } else {
          const kind: HourKind = day.kind === 'REST_DAY' ? 'REST_DAY' : 'HOLIDAY';
          sorted.forEach((e, i) => (at(e.place).hours[kind] += hours[i]));
          total[kind] += dayTotal;
        }
        break;
      }
      case 'ABSENT':
      case 'LEAVE':
      case 'SICK':
      case 'TRAVEL':
        if (day.kind !== 'WORKDAY') absencesOnDaysOff++;
        else if (first.status === 'ABSENT') absentDays++;
        else {
          absenceDays[first.status]++;
          at(first.place).absenceDays[first.status]++;
        }
        break;
      case 'OFF':
      case 'NOT_EMPLOYED':
        break;
    }
  }

  return {
    places: new Map([...places].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    summary: {
      normalHours: fromUnits(total.NORMAL),
      overtimeHours: fromUnits(total.OVERTIME),
      restDayHours: fromUnits(total.REST_DAY),
      holidayHours: fromUnits(total.HOLIDAY),
      daysWorked,
      workdaysWorked,
      splitDays,
      absentDays,
      leaveDays: absenceDays.LEAVE,
      sickDays: absenceDays.SICK,
      travelDays: absenceDays.TRAVEL,
      absencesOnDaysOff,
      unrecordedDays: calendar.length - byDate.size,
    },
  };
}

/** The entry's hours in hundredths, checked against its status. */
function checkedHours(e: DayEntry): Units {
  const h = toUnits(e.hours, `hours on ${e.date}`);
  if (e.status === 'WORKED') {
    if (h <= 0n || h > MAX_DAY) {
      throw new RangeError(`Hours on ${e.date} must be more than 0 and at most ${MAX_HOURS_PER_DAY}`);
    }
  } else if (h !== 0n) {
    throw new RangeError(`Entry on ${e.date} has hours but status ${e.status}`);
  }
  return h;
}
