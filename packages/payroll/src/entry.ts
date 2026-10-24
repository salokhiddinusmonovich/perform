import { fromUnits, tryUnits } from './decimal.js';

/**
 * Status of one worker on one day. Every company's Excel uses its own codes
 * (T, Y, IZ, İ, R, H, TR, B/T, "-"…); each company maps them onto this fixed set
 * (a CodeMap, stored per company) and the importer applies that mapping.
 */
export type DayStatus =
  | 'WORKED' // hours > 0
  | 'ABSENT' // did not come, unexcused
  | 'LEAVE' // approved leave
  | 'SICK'
  | 'TRAVEL' // transfer between sites / long trip
  | 'OFF' // rest day or holiday, not worked
  | 'NOT_EMPLOYED'; // before hire or after exit

export const DAY_STATUSES: readonly DayStatus[] = [
  'WORKED',
  'ABSENT',
  'LEAVE',
  'SICK',
  'TRAVEL',
  'OFF',
  'NOT_EMPLOYED',
];

/**
 * One worker's record for one calendar day at one place (site or team). A
 * worker who works at several places on one day has one entry per place; any
 * other status is the worker's whole day, so it is the day's only entry.
 */
export interface DayEntry {
  /** ISO date, e.g. "2026-09-01". */
  date: string;
  /**
   * Where the entry was made: the caller's key for the site/team. Pay lines
   * are charged to it.
   */
  place: string;
  /**
   * Order the entries were created in (not edited in): of one worker's entries
   * for a day, the higher seq was entered later. Overtime and travel pay of a
   * split day go to the place entered later.
   */
  seq: number;
  status: DayStatus;
  /** Hours worked as a decimal string ("9", "7.5"); "0" unless status is WORKED. */
  hours: string;
}

/** A timesheet cell after parsing; the importer adds the date, place and seq. */
export type ParsedCell = Pick<DayEntry, 'status' | 'hours'>;

/**
 * A company's timesheet codes, keyed by normalizeCode(code). Codes are never
 * blank: what a blank cell means follows from the worker's employment dates.
 */
export type CodeMap = ReadonlyMap<string, DayStatus>;

export const MAX_HOURS_PER_DAY = 24;

/**
 * Normalizes a code for lookup. Excel files mix Turkish and Latin "i", so İ/I/i
 * all fold to plain "I" (toLocaleUpperCase('tr-TR') would turn "i" into "İ").
 */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/İ/g, 'I');
}

/**
 * Parses a raw timesheet cell for a day the worker is (employed = true) or
 * isn't (before hire, after exit) employed.
 * - Employed: a number from more than 0 to 24 with at most 2 decimal places is
 *   hours worked; anything else is looked up in the company's codes. A blank
 *   cell is missing data, and a "not employed" code contradicts the dates.
 * - Not employed: only a blank cell or a "not employed" code fits.
 * Returns null for anything that doesn't fit (unknown codes, negative or
 * impossible hours, blanks during employment…) so the importer reports it as a
 * problem row instead of guessing.
 */
export function parseCell(raw: unknown, codes: CodeMap, employed: boolean): ParsedCell | null {
  let text: string;
  if (raw === null || raw === undefined) text = '';
  else if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    text = String(raw);
  } else if (typeof raw === 'string') text = raw;
  else return null;

  const code = normalizeCode(text);
  let cell: ParsedCell | null;
  if (code === '') {
    cell = { status: 'NOT_EMPLOYED', hours: '0' };
  } else {
    const hours = tryUnits(code.replace(',', '.'));
    if (hours !== null && hours > 0n && hours <= BigInt(MAX_HOURS_PER_DAY) * 100n) {
      cell = { status: 'WORKED', hours: fromUnits(hours) };
    } else {
      const status = codes.get(code);
      cell = status ? { status, hours: '0' } : null;
    }
  }
  if (!cell) return null;
  return (cell.status === 'NOT_EMPLOYED') === !employed ? cell : null;
}
