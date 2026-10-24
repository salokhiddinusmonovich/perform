import { z } from 'zod';
import { ROLES } from './company.js';
import { contactSchema } from './contact.js';
import { decimalSchema, isoDateSchema, yearMonthSchema } from './pay-rules.js';

// What the platform admin (the product operator) manages: user accounts, plans and
// subscription payments (AGENTS.md: Platform admin). Amounts are in soʻm.

/** An amount in soʻm, e.g. a plan's price or a payment; 0 is allowed (free). */
const somSchema = decimalSchema({ min: 0, max: 999_999_999_999, rangeError: 'validation.amountRange' });

const optionalNote = z
  .string()
  .nullish()
  .transform((value) => (value?.trim() ? value.trim() : null))
  .pipe(z.string().max(500, { error: 'validation.tooLong' }).nullable());

/** A new account, not yet in any company (e.g. another platform admin). */
export const createPlatformUserSchema = contactSchema.and(z.object({ isPlatformAdmin: z.boolean() }));
export type CreatePlatformUserInput = z.input<typeof createPlatformUserSchema>;
export type CreatePlatformUser = z.output<typeof createPlatformUserSchema>;

/** Changes to an account: its name and logins, whether it is active, platform admin or not. */
export const updatePlatformUserSchema = z
  .object({
    contact: contactSchema.optional(),
    isActive: z.boolean().optional(),
    isPlatformAdmin: z.boolean().optional(),
  })
  .refine((v) => v.contact !== undefined || v.isActive !== undefined || v.isPlatformAdmin !== undefined, {
    error: 'validation.nothingToUpdate',
  });
export type UpdatePlatformUserInput = z.input<typeof updatePlatformUserSchema>;
export type UpdatePlatformUser = z.output<typeof updatePlatformUserSchema>;

/** Puts a person in a company with a role, or changes their role or access there. */
export const platformMembershipSchema = z.object({
  role: z.enum(ROLES, { error: 'validation.required' }),
  isActive: z.boolean(),
});
export type PlatformMembershipInput = z.input<typeof platformMembershipSchema>;
export type PlatformMembership = z.output<typeof platformMembershipSchema>;

export const planSchema = z.object({
  name: z
    .string({ error: 'validation.required' })
    .trim()
    .min(1, { error: 'validation.required', abort: true })
    .max(60, { error: 'validation.tooLong' }),
  monthlyPrice: somSchema,
  maxActiveWorkers: z
    .number({ error: 'validation.required' })
    .int({ error: 'validation.invalid' })
    .min(1, { error: 'validation.workerLimitRange' })
    .max(1_000_000, { error: 'validation.workerLimitRange' }),
  timesheetModule: z.boolean(),
});
export type PlanInput = z.input<typeof planSchema>;
export type Plan = z.output<typeof planSchema>;

/** Editing a plan, or archiving it (isActive false) and bringing it back. */
export const updatePlanSchema = planSchema
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((v) => Object.values(v).some((value) => value !== undefined), {
    error: 'validation.nothingToUpdate',
  });
export type UpdatePlanInput = z.input<typeof updatePlanSchema>;
export type UpdatePlan = z.output<typeof updatePlanSchema>;

/** A payment made outside the app; it sets the month the company is paid through. */
export const subscriptionPaymentSchema = z.object({
  amount: somSchema,
  paidOn: isoDateSchema,
  paidThrough: yearMonthSchema,
  note: optionalNote,
});
export type SubscriptionPaymentInput = z.input<typeof subscriptionPaymentSchema>;
export type SubscriptionPayment = z.output<typeof subscriptionPaymentSchema>;
