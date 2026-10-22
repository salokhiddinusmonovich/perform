import { z } from 'zod';
import { contactSchema } from './contact.js';
import { isoDateSchema } from './pay-rules.js';

/** Mirrors the Role enum in apps/api/prisma/schema.prisma. */
export const ROLES = ['OWNER', 'ADMIN', 'ACCOUNTANT', 'PROJECT_MANAGER', 'TIMEKEEPER', 'FOREMAN'] as const;
export type Role = (typeof ROLES)[number];

/** Roles that may manage company settings and users. */
export const MANAGER_ROLES: readonly Role[] = ['OWNER', 'ADMIN'];

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const companySettingsSchema = z.object({
  name: z
    .string({ error: 'validation.required' })
    .trim()
    .min(1, { error: 'validation.required', abort: true })
    .min(2, { error: 'validation.nameTooShort' })
    .max(120, { error: 'validation.tooLong' }),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, { error: 'validation.currencyInvalid' }),
  timezone: z.string().trim().refine(isTimeZone, { error: 'validation.timezoneInvalid' }),
});
/** `…Input` = what a form sends; the type without the suffix = the validated result. */
export type CompanySettingsInput = z.input<typeof companySettingsSchema>;
export type CompanySettings = z.output<typeof companySettingsSchema>;

/** A new company (platform admin): its plan and first paid-until date (e.g. the trial's end) are required. */
export const createCompanySchema = companySettingsSchema.extend({
  owner: contactSchema,
  planId: z.uuid({ error: 'validation.required' }),
  paidUntil: isoDateSchema,
});
export type CreateCompanyInput = z.input<typeof createCompanySchema>;
export type CreateCompany = z.output<typeof createCompanySchema>;

/** What the platform admin changes on a company: its settings, plan, or whether it is active. */
export const updatePlatformCompanySchema = companySettingsSchema
  .partial()
  .extend({
    isActive: z.boolean().optional(),
    planId: z.uuid({ error: 'validation.required' }).optional(),
  })
  .refine((v) => Object.values(v).some((value) => value !== undefined), {
    error: 'validation.nothingToUpdate',
  });
export type UpdatePlatformCompanyInput = z.input<typeof updatePlatformCompanySchema>;
export type UpdatePlatformCompany = z.output<typeof updatePlatformCompanySchema>;

export const createMemberSchema = contactSchema.and(
  z.object({
    role: z.enum(ROLES, { error: 'validation.required' }),
  }),
);
export type CreateMemberInput = z.input<typeof createMemberSchema>;
export type CreateMember = z.output<typeof createMemberSchema>;

export const updateMemberSchema = z
  .object({
    role: z.enum(ROLES).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => v.role !== undefined || v.isActive !== undefined, {
    error: 'validation.nothingToUpdate',
  });
export type UpdateMemberInput = z.input<typeof updateMemberSchema>;
export type UpdateMember = z.output<typeof updateMemberSchema>;
