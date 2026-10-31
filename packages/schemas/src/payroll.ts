import { z } from 'zod';
import { optionalText, optionalUuid } from './organisation.js';
import { decimalSchema, isoDateSchema } from './pay-rules.js';

// Hours entered as monthly totals and the payroll run (AGENTS.md: Modules, Pay model).

/** Hours in a month: at most 31 days × 24 hours. */
const monthHoursSchema = decimalSchema({ min: 0, max: 744, rangeError: 'validation.monthHoursRange' });
const daysSchema = z
  .number({ error: 'validation.required' })
  .int({ error: 'validation.invalid' })
  .min(0, { error: 'validation.daysRange' })
  .max(31, { error: 'validation.daysRange' });

/**
 * One placement's hours for a month, entered as totals (MonthlyTotals in
 * @puantaj/payroll). Only ever added: a correction is a newer entry.
 */
export const monthlyHoursSchema = z.object({
  /**
   * The part of the month the totals are for: the days of one shift in it (AGENTS.md:
   * Shifts), the whole month while the worker's shift doesn't change.
   */
  from: isoDateSchema,
  until: isoDateSchema,
  normalHours: monthHoursSchema,
  overtimeHours: monthHoursSchema,
  restDayHours: monthHoursSchema,
  holidayHours: monthHoursSchema,
  /** Working days with hours worked (travel pay per day worked counts these). */
  workdaysWorked: daysSchema,
  leaveDays: daysSchema,
  sickDays: daysSchema,
  travelDays: daysSchema,
  note: optionalText(500),
});
export type MonthlyHoursInput = z.input<typeof monthlyHoursSchema>;
export type MonthlyHours = z.output<typeof monthlyHoursSchema>;

const requiredReason = z
  .string({ error: 'validation.required' })
  .trim()
  .min(1, { error: 'validation.required', abort: true })
  .max(500, { error: 'validation.tooLong' });

/** Reopening a locked month: owners only, always with a reason (AGENTS.md: Data integrity). */
export const unlockSchema = z.object({ reason: requiredReason });
export type UnlockInput = z.input<typeof unlockSchema>;
export type Unlock = z.output<typeof unlockSchema>;

/** Mirrors AdjustmentType in apps/api/prisma/schema.prisma (AdjustmentType in @puantaj/payroll). */
export const ADJUSTMENT_TYPES = ['BONUS', 'ADVANCE', 'DEDUCTION'] as const;
export type AdjustmentType = (typeof ADJUSTMENT_TYPES)[number];

/**
 * Money added to or taken from a worker's pay for a month (AGENTS.md: Adjustments). The
 * amount is always positive; the type gives the sign. Fits Decimal(14,2).
 */
export const adjustmentSchema = z.object({
  /** The payslip it belongs to (AGENTS.md: Firms); required by the API when the worker has more than one firm that month. */
  firmId: optionalUuid,
  type: z.enum(ADJUSTMENT_TYPES, { error: 'validation.required' }),
  amount: decimalSchema({ min: 0, minExclusive: true, max: 999_999_999_999, rangeError: 'validation.adjustmentRange' }),
  note: optionalText(500),
});
export type AdjustmentInput = z.input<typeof adjustmentSchema>;
export type Adjustment = z.output<typeof adjustmentSchema>;

/** Cancelling a mistaken adjustment, always with a reason. */
export const cancelAdjustmentSchema = z.object({ reason: requiredReason });
export type CancelAdjustmentInput = z.input<typeof cancelAdjustmentSchema>;
export type CancelAdjustment = z.output<typeof cancelAdjustmentSchema>;
