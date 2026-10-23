import { z } from 'zod';
import { optionalText } from './organisation.js';
import { decimalSchema } from './pay-rules.js';

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

/** Reopening a locked month: owners only, always with a reason (AGENTS.md: Data integrity). */
export const unlockSchema = z.object({
  reason: z
    .string({ error: 'validation.required' })
    .trim()
    .min(1, { error: 'validation.required', abort: true })
    .max(500, { error: 'validation.tooLong' }),
});
export type UnlockInput = z.input<typeof unlockSchema>;
export type Unlock = z.output<typeof unlockSchema>;
