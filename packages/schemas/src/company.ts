import { z } from 'zod';
import { contactSchema } from './contact.js';

/** Mirrors the Role enum in apps/api/prisma/schema.prisma. */
export const ROLES = ['OWNER', 'ADMIN', 'ACCOUNTANT', 'TIMEKEEPER', 'FOREMAN'] as const;
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

export const createCompanySchema = companySettingsSchema.extend({
  owner: contactSchema,
});
export type CreateCompanyInput = z.input<typeof createCompanySchema>;
export type CreateCompany = z.output<typeof createCompanySchema>;

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
