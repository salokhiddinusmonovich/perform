import type { CalendarDay, WorkingDays } from './calendar';
import { divRound, fromUnits, SCALE, toUnits, type Units } from './decimal';
import { MAX_HOURS_PER_DAY, type DayEntry } from './entry';
import {
  ABSENCE_TYPES,
  HOUR_KINDS,
  summarizeUnits,
  type AbsenceType,
  type HourKind,
  type HoursSummary,
} from './summary';

/** Pay for one absence type (Settings). */
export interface AbsenceRule {
  paid: boolean;
  /** Hours paid per absence day; null = the normal hours per day. */
  hoursPerDay: string | null;
}

/** Pay policy from Settings. Decimal values are strings with at most 2 decimals. */
export interface PaySettings {
  normalHoursPerDay: string;
  multipliers: Record<HourKind, string>;
  absence: Record<AbsenceType, AbsenceRule>;
  /** The total is rounded to the nearest multiple of this (e.g. "1000" soʻm). */
  payRoundingStep: string;
}

/** This worker's travel pay for the month, resolved from Settings by the caller. */
export type TravelInput =
  | { kind: 'PER_DAY_WORKED'; route: string; amountPerDay: string }
  | { kind: 'MONTHLY_AMOUNT'; amount: string };

export interface PayInput {
  monthlySalary: string;
  workingDays: WorkingDays;
  calendar: readonly CalendarDay[];
  entries: readonly DayEntry[];
  settings: PaySettings;
  /** null = no travel pay for this worker this month */
  travel: TravelInput | null;
}

/** One explainable amount: every line carries the inputs it was computed from. */
export type PayLine =
  | {
      type: 'HOURS';
      kind: HourKind;
      hours: string;
      multiplier: string;
      /** hours × hourly rate × multiplier */
      amount: string;
    }
  | {
      type: 'ABSENCE';
      absence: AbsenceType;
      days: number;
      paid: boolean;
      hoursPerDay: string;
      /** SETTING: hours per day set for this absence type; NORMAL_DAY: the normal hours per day */
      hoursPerDaySource: 'SETTING' | 'NORMAL_DAY';
      /** days × hours per day when paid, else 0 */
      hours: string;
      /** hours × hourly rate */
      amount: string;
    }
  | {
      type: 'TRAVEL_PER_DAY';
      route: string;
      /** working days worked; rest days and holidays worked don't count */
      days: number;
      amountPerDay: string;
      amount: string;
    }
  | { type: 'TRAVEL_MONTHLY'; amount: string }
  | {
      type: 'ROUNDING';
      step: string;
      /** rounded total − sum of the other lines (may be negative) */
      amount: string;
    };

export interface PayResult {
  /** hourly rate = monthlySalary ÷ (workingDays.effective × normalHoursPerDay) */
  hourlyRate: {
    monthlySalary: string;
    workingDays: WorkingDays;
    normalHoursPerDay: string;
    /**
     * The rate rounded to 2 decimals, for display. Amounts are computed from the
     * exact fraction, so a full month at normal hours pays exactly the salary.
     */
    rounded: string;
  };
  summary: HoursSummary;
  lines: PayLine[];
  /** Sum of the line amounts, a multiple of settings.payRoundingStep. */
  total: string;
}

const MAX_DAY = BigInt(MAX_HOURS_PER_DAY) * SCALE;

/**
 * Calculates a worker's pay for a month under the hour-based pay model:
 * - hourly rate = monthly salary ÷ (working days × normal hours per day)
 * - worked hours: hours × hourly rate × the multiplier for their kind
 * - paid absences: absence days × hours paid per day × hourly rate
 * - travel: working days worked × the route's amount per day, or the monthly amount
 * - the total is rounded to the nearest payRoundingStep (halves up), shown as a
 *   ROUNDING line.
 * Each line is computed as one exact fraction and rounded once to 0.01
 * (halves away from zero); the total is the sum of the lines, so the breakdown
 * always adds up to it.
 */
export function calculatePay(input: PayInput): PayResult {
  const { settings, workingDays } = input;
  const salary = nonNegative(input.monthlySalary, 'monthlySalary');
  const normalDay = toUnits(settings.normalHoursPerDay, 'normalHoursPerDay');
  const wd = BigInt(workingDays.effective);
  if (!Number.isInteger(workingDays.effective) || wd <= 0n) {
    throw new RangeError(`Working days must be a positive whole number, got ${workingDays.effective}`);
  }
  const { hours, absenceDays, summary } = summarizeUnits(input.calendar, input.entries, normalDay);

  /** hours × (salary ÷ (wd × normalDay)) × multiplier, all in hundredths. */
  const amountFor = (h: Units, multiplier: Units): Units =>
    divRound(h * salary * multiplier, wd * normalDay * SCALE);

  const lines: PayLine[] = [];

  for (const kind of HOUR_KINDS) {
    if (hours[kind] === 0n) continue;
    const multiplier = nonNegative(settings.multipliers[kind], `multipliers.${kind}`);
    lines.push({
      type: 'HOURS',
      kind,
      hours: fromUnits(hours[kind]),
      multiplier: fromUnits(multiplier),
      amount: fromUnits(amountFor(hours[kind], multiplier)),
    });
  }

  for (const absence of ABSENCE_TYPES) {
    const days = absenceDays[absence];
    if (days === 0) continue;
    const rule = settings.absence[absence];
    const perDay = rule.hoursPerDay === null ? normalDay : nonNegative(rule.hoursPerDay, `absence.${absence}.hoursPerDay`);
    if (perDay > MAX_DAY) throw new RangeError(`absence.${absence}.hoursPerDay must be at most ${MAX_HOURS_PER_DAY}`);
    const paidHours = rule.paid ? perDay * BigInt(days) : 0n;
    lines.push({
      type: 'ABSENCE',
      absence,
      days,
      paid: rule.paid,
      hoursPerDay: fromUnits(perDay),
      hoursPerDaySource: rule.hoursPerDay === null ? 'NORMAL_DAY' : 'SETTING',
      hours: fromUnits(paidHours),
      amount: fromUnits(amountFor(paidHours, SCALE)),
    });
  }

  const travel = input.travel;
  if (travel?.kind === 'PER_DAY_WORKED' && summary.workdaysWorked > 0) {
    const perDay = nonNegative(travel.amountPerDay, 'travel.amountPerDay');
    lines.push({
      type: 'TRAVEL_PER_DAY',
      route: travel.route,
      days: summary.workdaysWorked,
      amountPerDay: fromUnits(perDay),
      amount: fromUnits(perDay * BigInt(summary.workdaysWorked)),
    });
  } else if (travel?.kind === 'MONTHLY_AMOUNT') {
    lines.push({ type: 'TRAVEL_MONTHLY', amount: fromUnits(nonNegative(travel.amount, 'travel.amount')) });
  }

  const step = toUnits(settings.payRoundingStep, 'payRoundingStep');
  if (step <= 0n) throw new RangeError('payRoundingStep must be more than 0');
  const exact = lines.reduce((sum, line) => sum + toUnits(line.amount), 0n);
  const total = divRound(exact, step) * step;
  if (total !== exact) {
    lines.push({ type: 'ROUNDING', step: fromUnits(step), amount: fromUnits(total - exact) });
  }
  return {
    hourlyRate: {
      monthlySalary: fromUnits(salary),
      workingDays,
      normalHoursPerDay: fromUnits(normalDay),
      rounded: fromUnits(divRound(salary * SCALE, wd * normalDay)),
    },
    summary,
    lines,
    total: fromUnits(total),
  };
}

function nonNegative(value: string, what: string): Units {
  const units = toUnits(value, what);
  if (units < 0n) throw new RangeError(`${what} must not be negative`);
  return units;
}
