import type { CalendarDay, WorkingDays } from './calendar';
import { divRound, fromUnits, SCALE, toUnits, type Units } from './decimal';
import { MAX_HOURS_PER_DAY, type DayEntry } from './entry';
import {
  ABSENCE_TYPES,
  HOUR_KINDS,
  summarizeUnits,
  totalsToUnits,
  type AbsenceType,
  type HourKind,
  type HoursSummary,
  type PlaceTotals,
  type PlaceUnits,
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

/** A travel route and its pay per day worked. */
export interface TravelRouteRate {
  route: string;
  amountPerDay: string;
}

/** This worker's travel pay for the month, resolved from Settings by the caller. */
export type TravelInput =
  | {
      kind: 'PER_DAY_WORKED';
      /**
       * The worker's route at each place (DayEntry.place), or null where they
       * have none. A place that has travel days but is missing here is an error.
       */
      routes: Readonly<Record<string, TravelRouteRate | null>>;
    }
  | { kind: 'MONTHLY_AMOUNT'; amount: string };

interface PayInputBase {
  monthlySalary: string;
  workingDays: WorkingDays;
  calendar: readonly CalendarDay[];
  settings: PaySettings;
  /** null = no travel pay for this worker this month */
  travel: TravelInput | null;
}

/** Hours from daily entries (the timesheet or an Excel import of the daily grid). */
export interface DailyPayInput extends PayInputBase {
  entries: readonly DayEntry[];
}

/** Hours entered as monthly totals, per place (e.g. per placement); pay lines are charged to those places. */
export interface TotalsPayInput extends PayInputBase {
  totals: readonly PlaceTotals[];
}

export type PayInput = DailyPayInput | TotalsPayInput;

/**
 * One explainable amount: every line carries the inputs it was computed from.
 * Lines that come from timesheet entries name the place (DayEntry.place) they
 * are charged to; there is one such line per place.
 */
export type PayLine =
  | {
      type: 'HOURS';
      place: string;
      kind: HourKind;
      hours: string;
      multiplier: string;
      /** hours × hourly rate × multiplier */
      amount: string;
    }
  | {
      type: 'ABSENCE';
      place: string;
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
      place: string;
      /** null: the worker has no route at this place, so these days pay nothing */
      route: string | null;
      /**
       * Working days worked charged to this place. Rest days and holidays worked
       * don't count, and a split day counts once, for the place entered last.
       */
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

interface PayResultBase {
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
  lines: PayLine[];
  /** Sum of the line amounts, a multiple of settings.payRoundingStep. */
  total: string;
}

/** Every result says where its hours came from (AGENTS.md: Modules). */
export interface DailyPayResult extends PayResultBase {
  source: 'DAILY';
  summary: HoursSummary;
}

export interface TotalsPayResult extends PayResultBase {
  source: 'TOTALS';
  totals: readonly PlaceTotals[];
}

export type PayResult = DailyPayResult | TotalsPayResult;

const MAX_DAY = BigInt(MAX_HOURS_PER_DAY) * SCALE;

/**
 * Calculates a worker's pay for a month under the hour-based pay model:
 * - hourly rate = monthly salary ÷ (working days × normal hours per day)
 * - worked hours: hours × hourly rate × the multiplier for their kind
 * - paid absences: absence days × hours paid per day × hourly rate
 * - travel: working days worked × the route's amount per day, or the monthly amount
 * - the total is rounded to the nearest payRoundingStep (halves up), shown as a
 *   ROUNDING line.
 * Hours, absences and travel days are charged to the place they were entered at;
 * summarizeUnits explains how a day worked at several places is split.
 * Each line is computed as one exact fraction and rounded once to 0.01
 * (halves away from zero); the total is the sum of the lines, so the breakdown
 * always adds up to it.
 *
 * Hours come from daily entries or from monthly totals (checkTotals first: totals
 * that don't fit the month throw).
 */
export function calculatePay(input: DailyPayInput): DailyPayResult;
export function calculatePay(input: TotalsPayInput): TotalsPayResult;
export function calculatePay(input: PayInput): PayResult;
export function calculatePay(input: PayInput): PayResult {
  const { settings, workingDays } = input;
  const salary = nonNegative(input.monthlySalary, 'monthlySalary');
  const normalDay = toUnits(settings.normalHoursPerDay, 'normalHoursPerDay');
  const wd = BigInt(workingDays.effective);
  if (!Number.isInteger(workingDays.effective) || wd <= 0n) {
    throw new RangeError(`Working days must be a positive whole number, got ${workingDays.effective}`);
  }
  const daily = 'entries' in input ? summarizeUnits(input.calendar, input.entries, normalDay) : null;
  const places: ReadonlyMap<string, PlaceUnits> = daily
    ? daily.places
    : totalsToUnits((input as TotalsPayInput).totals, input.calendar, normalDay);

  /** hours × (salary ÷ (wd × normalDay)) × multiplier, all in hundredths. */
  const amountFor = (h: Units, multiplier: Units): Units =>
    divRound(h * salary * multiplier, wd * normalDay * SCALE);

  const lines: PayLine[] = [];
  /** Adds a line for each place where pick() finds something to pay. */
  const perPlace = <T>(pick: (units: PlaceUnits) => T | null, line: (place: string, value: T) => PayLine) => {
    for (const [place, units] of places) {
      const value = pick(units);
      if (value !== null) lines.push(line(place, value));
    }
  };

  for (const kind of HOUR_KINDS) {
    perPlace(
      (u) => (u.hours[kind] === 0n ? null : u.hours[kind]),
      (place, hours) => {
        const multiplier = nonNegative(settings.multipliers[kind], `multipliers.${kind}`);
        return {
          type: 'HOURS',
          place,
          kind,
          hours: fromUnits(hours),
          multiplier: fromUnits(multiplier),
          amount: fromUnits(amountFor(hours, multiplier)),
        };
      },
    );
  }

  for (const absence of ABSENCE_TYPES) {
    perPlace(
      (u) => (u.absenceDays[absence] === 0 ? null : u.absenceDays[absence]),
      (place, days) => {
        const rule = settings.absence[absence];
        const perDay =
          rule.hoursPerDay === null ? normalDay : nonNegative(rule.hoursPerDay, `absence.${absence}.hoursPerDay`);
        if (perDay > MAX_DAY) {
          throw new RangeError(`absence.${absence}.hoursPerDay must be at most ${MAX_HOURS_PER_DAY}`);
        }
        const paidHours = rule.paid ? perDay * BigInt(days) : 0n;
        return {
          type: 'ABSENCE',
          place,
          absence,
          days,
          paid: rule.paid,
          hoursPerDay: fromUnits(perDay),
          hoursPerDaySource: rule.hoursPerDay === null ? 'NORMAL_DAY' : 'SETTING',
          hours: fromUnits(paidHours),
          amount: fromUnits(amountFor(paidHours, SCALE)),
        };
      },
    );
  }

  const travel = input.travel;
  if (travel?.kind === 'PER_DAY_WORKED') {
    perPlace(
      (u) => (u.travelDays === 0 ? null : u.travelDays),
      (place, days) => {
        if (!Object.hasOwn(travel.routes, place)) throw new RangeError(`No travel route given for ${place}`);
        const route = travel.routes[place];
        const perDay = route === null ? 0n : nonNegative(route.amountPerDay, `travel.routes.${place}.amountPerDay`);
        return {
          type: 'TRAVEL_PER_DAY',
          place,
          route: route === null ? null : route.route,
          days,
          amountPerDay: fromUnits(perDay),
          amount: fromUnits(perDay * BigInt(days)),
        };
      },
    );
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
  const base: PayResultBase = {
    hourlyRate: {
      monthlySalary: fromUnits(salary),
      workingDays,
      normalHoursPerDay: fromUnits(normalDay),
      rounded: fromUnits(divRound(salary * SCALE, wd * normalDay)),
    },
    lines,
    total: fromUnits(total),
  };
  return daily
    ? { source: 'DAILY', summary: daily.summary, ...base }
    : { source: 'TOTALS', totals: (input as TotalsPayInput).totals, ...base };
}

/**
 * A worker's month paid in parts, one per rule set their placements fall under
 * (AGENTS.md: split by placement). Each part is computed and rounded under its own
 * rules; the month's total is their sum.
 */
export function totalOfParts(parts: readonly PayResult[]): string {
  return fromUnits(parts.reduce((sum, part) => sum + toUnits(part.total), 0n));
}

function nonNegative(value: string, what: string): Units {
  const units = toUnits(value, what);
  if (units < 0n) throw new RangeError(`${what} must not be negative`);
  return units;
}
