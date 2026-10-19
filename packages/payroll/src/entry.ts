/**
 * Status of one worker on one day. Every company's Excel uses its own codes
 * (T, Y, IZ, İ, R, H, TR, B/T, "-"…); importers map them onto this fixed set.
 */
export type DayStatus =
  | 'WORKED' // hours > 0
  | 'ABSENT' // did not come, unexcused
  | 'LEAVE' // approved leave
  | 'SICK'
  | 'TRAVEL' // transfer between sites / long trip
  | 'OFF' // rest day or holiday, not worked
  | 'NOT_EMPLOYED'; // before hire or after exit

export interface DayEntry {
  status: DayStatus;
  /** Hours worked; only meaningful when status is WORKED. */
  hours: number;
}

const CODE_MAP: Record<string, DayStatus> = {
  T: 'OFF',
  'B/T': 'OFF',
  BT: 'OFF',
  Y: 'ABSENT',
  YOK: 'ABSENT',
  IZ: 'LEAVE',
  I: 'LEAVE',
  R: 'SICK',
  H: 'SICK',
  TR: 'TRAVEL',
  '-': 'NOT_EMPLOYED',
  '': 'NOT_EMPLOYED',
};

/**
 * Parses a raw timesheet cell. Numbers are hours. Returns null for values that
 * cannot be understood so the importer can report them instead of guessing.
 */
export function parseCell(raw: unknown): DayEntry | null {
  if (raw === null || raw === undefined) return { status: 'NOT_EMPLOYED', hours: 0 };
  if (typeof raw === 'number') {
    return raw > 0 ? { status: 'WORKED', hours: raw } : { status: 'OFF', hours: 0 };
  }
  // Excel files mix Turkish and Latin "i": fold İ/I/i to plain "I".
  const text = String(raw).trim().toUpperCase().replace(/İ/g, 'I');
  const asNumber = Number(text.replace(',', '.'));
  if (text !== '' && Number.isFinite(asNumber)) return parseCell(asNumber);
  const status = CODE_MAP[text];
  return status ? { status, hours: 0 } : null;
}
