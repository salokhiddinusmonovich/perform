import { parsePhoneNumberFromString } from 'libphonenumber-js/min';
import { z } from 'zod';

/** Phone numbers without a country code are read as Uzbek numbers. */
const DEFAULT_COUNTRY = 'UZ';

/** Returns the phone number in E.164 form (e.g. "+998901234567"), or null if invalid. */
export function normalizePhone(raw: string): string | null {
  const phone = parsePhoneNumberFromString(raw.trim(), DEFAULT_COUNTRY);
  return phone?.isValid() ? phone.number : null;
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export type LoginIdentifier = { kind: 'email'; value: string } | { kind: 'phone'; value: string };

/** A login can be an email or a phone number. Returns null if it is neither. */
export function parseIdentifier(raw: string): LoginIdentifier | null {
  const value = raw.trim();
  if (value.includes('@')) {
    const email = normalizeEmail(value);
    return z.email().safeParse(email).success ? { kind: 'email', value: email } : null;
  }
  const phone = normalizePhone(value);
  return phone ? { kind: 'phone', value: phone } : null;
}

// Optional contact fields: an empty form field means "not provided".
// Input type stays `string | undefined` so forms get precise field types.

export const emailSchema = z
  .string()
  .optional()
  .transform((value) => (value?.trim() ? normalizeEmail(value) : undefined))
  .pipe(z.email({ error: 'validation.emailInvalid' }).optional());

export const phoneSchema = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (!value?.trim()) return undefined;
    const phone = normalizePhone(value);
    if (!phone) {
      ctx.addIssue({ code: 'custom', message: 'validation.phoneInvalid' });
      return z.NEVER;
    }
    return phone;
  });

export const fullNameSchema = z
  .string({ error: 'validation.required' })
  .trim()
  .min(1, { error: 'validation.required', abort: true })
  .min(2, { error: 'validation.nameTooShort' })
  .max(120, { error: 'validation.tooLong' });

/** Name plus at least one way to log in (phone or email). */
export const contactSchema = z
  .object({
    fullName: fullNameSchema,
    email: emailSchema,
    phone: phoneSchema,
  })
  .refine((c) => c.email !== undefined || c.phone !== undefined, {
    error: 'validation.phoneOrEmailRequired',
    path: ['phone'],
  });

export type ContactInput = z.input<typeof contactSchema>;
export type Contact = z.output<typeof contactSchema>;
