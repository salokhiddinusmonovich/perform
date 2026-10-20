/**
 * Uzbekistan's public holidays (non-working days under the Labour Code).
 * Fixed-date holidays are shipped here. Ramazon Hayit and Qurbon Hayit follow
 * the lunar calendar and are announced each year, so an admin enters them, along
 * with company days off and both halves of day-off swaps the government declares
 * (the extra day off, and the rest weekday that becomes a working day).
 */

/** Holidays an admin enters per year (Holiday.kind in the database). */
export type EnteredHolidayKind =
  | 'RAMAZON_HAYIT'
  | 'QURBON_HAYIT'
  | 'PUBLIC_EXTRA'
  | 'COMPANY_DAY_OFF'
  /** Not a day off: a rest weekday made a working day (CalendarOptions.extraWorkdays). */
  | 'WORKING_DAY';

/** Moving public holidays every year must have; a year without them is incomplete. */
export const MOVING_HOLIDAYS = ['RAMAZON_HAYIT', 'QURBON_HAYIT'] as const satisfies readonly EnteredHolidayKind[];
export type MovingHoliday = (typeof MOVING_HOLIDAYS)[number];

export type FixedHolidayKey =
  | 'NEW_YEAR'
  | 'WOMENS_DAY'
  | 'NAVRUZ'
  | 'REMEMBRANCE_DAY'
  | 'INDEPENDENCE_DAY'
  | 'TEACHERS_DAY'
  | 'CONSTITUTION_DAY';

const UZ_FIXED: readonly { key: FixedHolidayKey; month: number; day: number }[] = [
  { key: 'NEW_YEAR', month: 1, day: 1 },
  { key: 'WOMENS_DAY', month: 3, day: 8 },
  { key: 'NAVRUZ', month: 3, day: 21 },
  { key: 'REMEMBRANCE_DAY', month: 5, day: 9 },
  { key: 'INDEPENDENCE_DAY', month: 9, day: 1 },
  { key: 'TEACHERS_DAY', month: 10, day: 1 },
  { key: 'CONSTITUTION_DAY', month: 12, day: 8 },
];

export interface FixedHoliday {
  /** ISO date */
  date: string;
  /** Stable key; the UI translates it. */
  key: FixedHolidayKey;
}

/** Uzbekistan's fixed-date public holidays in a year. */
export function uzbekistanFixedHolidays(year: number): FixedHoliday[] {
  return UZ_FIXED.map(({ key, month, day }) => ({
    key,
    date: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  }));
}

/**
 * Moving holidays not yet entered for a year, given the kinds of the holidays
 * entered for that year. A non-empty result is a warning to show the admin: the
 * year's working days (and so hourly rates) are wrong until they are entered.
 */
export function missingMovingHolidays(enteredKinds: Iterable<EnteredHolidayKind>): MovingHoliday[] {
  const entered = new Set(enteredKinds);
  return MOVING_HOLIDAYS.filter((kind) => !entered.has(kind));
}
