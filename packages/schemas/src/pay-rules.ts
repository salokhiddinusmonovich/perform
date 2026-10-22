import { z } from 'zod';

// Pay rules, holidays and working days (Settings). Value ranges match the CHECK
// constraints in apps/api/prisma/migrations.

/** Years the app accepts for months, holidays and rules. */
export const MIN_YEAR = 2000;
export const MAX_YEAR = 2100;

const yearSchema = z.coerce
  .number({ error: 'validation.invalid' })
  .int({ error: 'validation.invalid' })
  .min(MIN_YEAR, { error: 'validation.invalid' })
  .max(MAX_YEAR, { error: 'validation.invalid' });
const monthSchema = z.coerce
  .number({ error: 'validation.invalid' })
  .int({ error: 'validation.invalid' })
  .min(1, { error: 'validation.invalid' })
  .max(12, { error: 'validation.invalid' });

/** `?year=2026` */
export const yearQuerySchema = z.object({ year: yearSchema });
export type YearQuery = z.output<typeof yearQuerySchema>;

/** A month in a URL, e.g. `/pay-rules/2026/11`. Months are 1-based. */
export const yearMonthSchema = z.object({ year: yearSchema, month: monthSchema });
export type YearMonth = z.output<typeof yearMonthSchema>;

const DECIMAL = /^\d+(?:\.\d{1,2})?$/;

/**
 * A decimal typed in a form ("1,5" or "1.5"), at most 2 decimal places, as a
 * normalized string ("1.5") for the API and the payroll engine. Never a float.
 */
function decimalSchema({ min, max, minExclusive = false, rangeError }: {
  min: number;
  max: number;
  minExclusive?: boolean;
  rangeError: string;
}) {
  return z
    .string({ error: 'validation.required' })
    .trim()
    .min(1, { error: 'validation.required', abort: true })
    // "1 000" and "1,5" are how people write numbers in uz/ru/tr.
    .transform((value) => value.replace(/\s/g, '').replace(',', '.'))
    .refine((value) => DECIMAL.test(value), { error: 'validation.decimalInvalid', abort: true })
    .transform((value) => {
      const [whole, frac = ''] = value.split('.');
      const trimmedFrac = frac.replace(/0+$/, '');
      return `${BigInt(whole)}${trimmedFrac ? `.${trimmedFrac}` : ''}`;
    })
    .refine(
      (value) => {
        const n = Number(value); // exact enough to compare against small whole-number bounds
        return (minExclusive ? n > min : n >= min) && n <= max;
      },
      { error: rangeError },
    );
}

const hoursPerDaySchema = decimalSchema({ min: 0, max: 24, rangeError: 'validation.hoursRange' });
const multiplierSchema = decimalSchema({ min: 0, max: 99.99, rangeError: 'validation.multiplierRange' });

/** ISO weekdays, 1 = Monday … 7 = Sunday. */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** Mirrors TravelPayMode in apps/api/prisma/schema.prisma. */
export const TRAVEL_PAY_MODES = ['NONE', 'PER_DAY_WORKED', 'MONTHLY_AMOUNT'] as const;
export type TravelPayMode = (typeof TRAVEL_PAY_MODES)[number];

/** Absence types whose pay is set in Settings (AbsenceType in @puantaj/payroll). */
export const ABSENCE_RULE_TYPES = ['LEAVE', 'SICK', 'TRAVEL'] as const;
export type AbsenceRuleType = (typeof ABSENCE_RULE_TYPES)[number];

const absenceRuleSchema = z.object({
  paid: z.boolean(),
  /** Empty or null = the normal hours per day, following it when it changes. */
  hoursPerDay: z
    .string()
    .nullable()
    .transform((value) => (value?.trim() ? value : null))
    .pipe(hoursPerDaySchema.nullable()),
});

export const payRulesSchema = z.object({
  restWeekdays: z
    .array(z.number().int().min(1).max(7), { error: 'validation.invalid' })
    .transform((days) => [...new Set(days)].sort((a, b) => a - b))
    .refine((days) => days.length < 7, { error: 'validation.restWeekdaysAllWeek' }),
  normalHoursPerDay: decimalSchema({ min: 0, minExclusive: true, max: 24, rangeError: 'validation.normalHoursRange' }),
  overtimeMultiplier: multiplierSchema,
  restDayMultiplier: multiplierSchema,
  holidayMultiplier: multiplierSchema,
  absence: z.object({ LEAVE: absenceRuleSchema, SICK: absenceRuleSchema, TRAVEL: absenceRuleSchema }),
  travelPayMode: z.enum(TRAVEL_PAY_MODES, { error: 'validation.required' }),
  payRoundingStep: decimalSchema({
    min: 0,
    minExclusive: true,
    max: 1_000_000_000,
    rangeError: 'validation.roundingStepRange',
  }),
});
export type PayRulesInput = z.input<typeof payRulesSchema>;
export type PayRules = z.output<typeof payRulesSchema>;

/**
 * What a new company's rules form starts with: only the decided defaults
 * (AGENTS.md). Rest weekdays, normal hours, the multipliers and the travel pay
 * mode have none: the admin enters them.
 */
export const NEW_PAY_RULES: Omit<PayRulesInput, 'travelPayMode'> & { travelPayMode?: TravelPayMode } = {
  restWeekdays: [],
  normalHoursPerDay: '',
  overtimeMultiplier: '',
  restDayMultiplier: '',
  holidayMultiplier: '',
  absence: {
    LEAVE: { paid: true, hoursPerDay: null },
    SICK: { paid: true, hoursPerDay: '8' },
    TRAVEL: { paid: true, hoursPerDay: null },
  },
  payRoundingStep: '1000',
};

/** Mirrors HolidayKind in apps/api/prisma/schema.prisma (EnteredHolidayKind in @puantaj/payroll). */
export const HOLIDAY_KINDS = ['RAMAZON_HAYIT', 'QURBON_HAYIT', 'PUBLIC_EXTRA', 'COMPANY_DAY_OFF', 'WORKING_DAY'] as const;
export type HolidayKind = (typeof HOLIDAY_KINDS)[number];

/** A calendar day, "YYYY-MM-DD". */
/** A calendar day "YYYY-MM-DD" that exists, in a range of years. */
export const calendarDaySchema = (minYear: number, maxYear: number) =>
  z
    .string({ error: 'validation.required' })
    .trim()
    .min(1, { error: 'validation.required', abort: true })
    .refine(
      (value) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
        if (!m) return false;
        const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
        const date = new Date(Date.UTC(year, month - 1, day));
        return (
          year >= minYear &&
          year <= maxYear &&
          date.getUTCFullYear() === year &&
          date.getUTCMonth() === month - 1 &&
          date.getUTCDate() === day
        );
      },
      { error: 'validation.dateInvalid' },
    );

/** A day the app works with (timesheets, holidays, placements). */
export const isoDateSchema = calendarDaySchema(MIN_YEAR, MAX_YEAR);

export const holidaySchema = z.object({
  date: isoDateSchema,
  kind: z.enum(HOLIDAY_KINDS, { error: 'validation.required' }),
  /** Optional note; empty = none. */
  name: z
    .string()
    .nullish()
    .transform((value) => (value?.trim() ? value.trim() : null))
    .pipe(z.string().max(120, { error: 'validation.tooLong' }).nullable()),
});
export type HolidayInput = z.input<typeof holidaySchema>;
export type Holiday = z.output<typeof holidaySchema>;

export const workingDaysOverrideSchema = z.object({
  /** null = back to the calculated value */
  workingDays: z
    .number({ error: 'validation.required' })
    .int({ error: 'validation.invalid' })
    .min(1, { error: 'validation.workingDaysRange' })
    .max(31, { error: 'validation.workingDaysRange' })
    .nullable(),
  reason: z
    .string()
    .nullish()
    .transform((value) => (value?.trim() ? value.trim() : null))
    .pipe(z.string().max(500, { error: 'validation.tooLong' }).nullable()),
});
export type WorkingDaysOverrideInput = z.input<typeof workingDaysOverrideSchema>;
export type WorkingDaysOverride = z.output<typeof workingDaysOverrideSchema>;
