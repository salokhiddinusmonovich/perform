import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 10;

export const passwordSchema = z
  .string({ error: 'validation.required' })
  .min(PASSWORD_MIN_LENGTH, { error: 'validation.passwordTooShort' })
  .max(128, { error: 'validation.tooLong' });

export const loginSchema = z.object({
  identifier: z.string().trim().min(1, { error: 'validation.required' }),
  password: z.string().min(1, { error: 'validation.required' }),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, { error: 'validation.required' }),
    newPassword: passwordSchema,
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    error: 'validation.passwordMustDiffer',
    path: ['newPassword'],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const switchCompanySchema = z.object({
  companyId: z.uuid({ error: 'validation.invalid' }),
});
