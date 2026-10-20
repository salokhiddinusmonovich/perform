/**
 * Fixed-point decimals for payroll. Every number the engine multiplies (money,
 * hours, multipliers) is stored in the database as DECIMAL with 2 decimal places,
 * so the engine takes them as decimal strings (what Prisma's Decimal#toString()
 * gives) and works in integer hundredths with BigInt: exact, no rounding drift,
 * no dependency. A pay line is computed as one fraction and rounded once.
 */

/** Hundredths: "7500000.5" → 750000050n. */
export type Units = bigint;

export const SCALE = 100n;

const DECIMAL = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

/** Parses a decimal string with at most 2 decimal places. Throws on anything else. */
export function toUnits(value: string, what = 'value'): Units {
  const m = DECIMAL.exec(value.trim());
  if (!m) throw new RangeError(`${what} must be a decimal with at most 2 decimal places, got "${value}"`);
  const [, sign, whole, frac = ''] = m;
  const units = BigInt(whole) * SCALE + BigInt(frac.padEnd(2, '0'));
  return sign ? -units : units;
}

/** Like toUnits, but returns null instead of throwing (for parsing user input). */
export function tryUnits(value: string): Units | null {
  return DECIMAL.test(value.trim()) ? toUnits(value) : null;
}

/** 750000050n → "7500000.50". Always 2 decimal places, like DECIMAL(…, 2) columns. */
export function fromUnits(units: Units): string {
  const sign = units < 0n ? '-' : '';
  const abs = units < 0n ? -units : units;
  return `${sign}${abs / SCALE}.${(abs % SCALE).toString().padStart(2, '0')}`;
}

/** numerator ÷ denominator rounded to the nearest integer, halves away from zero. */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('Division by zero');
  if (denominator < 0n) return divRound(-numerator, -denominator);
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const q = (abs * 2n + denominator) / (denominator * 2n);
  return negative ? -q : q;
}
