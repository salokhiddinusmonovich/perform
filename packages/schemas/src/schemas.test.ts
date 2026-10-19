import { describe, expect, it } from 'vitest';
import {
  changePasswordSchema,
  companySettingsSchema,
  contactSchema,
  createMemberSchema,
  normalizePhone,
  parseIdentifier,
} from './index.js';

const messages = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.error?.issues.map((i) => i.message) ?? [];

describe('phones and identifiers', () => {
  it('normalizes Uzbek numbers written in different ways', () => {
    for (const raw of ['+998 90 123 45 67', '998901234567', '90 123-45-67', '(90) 1234567']) {
      expect(normalizePhone(raw)).toBe('+998901234567');
    }
  });

  it('accepts foreign numbers with a country code', () => {
    expect(normalizePhone('+90 532 123 45 67')).toBe('+905321234567');
  });

  it('rejects things that are not phone numbers', () => {
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('hello')).toBeNull();
  });

  it('tells emails and phones apart for login', () => {
    expect(parseIdentifier('  Boss@Example.COM ')).toEqual({ kind: 'email', value: 'boss@example.com' });
    expect(parseIdentifier('90 123 45 67')).toEqual({ kind: 'phone', value: '+998901234567' });
    expect(parseIdentifier('not-an-email@')).toBeNull();
    expect(parseIdentifier('abc')).toBeNull();
  });
});

describe('contactSchema', () => {
  it('says "required" for an empty name and "too short" for one letter', () => {
    expect(messages(contactSchema.safeParse({ fullName: '  ', phone: '901234567' }))).toEqual(['validation.required']);
    expect(messages(contactSchema.safeParse({ fullName: 'A', phone: '901234567' }))).toEqual(['validation.nameTooShort']);
  });

  it('needs a phone or an email', () => {
    const result = contactSchema.safeParse({ fullName: 'Test User', email: '', phone: '' });
    expect(messages(result)).toContain('validation.phoneOrEmailRequired');
  });

  it('normalizes the values it accepts', () => {
    const result = contactSchema.parse({ fullName: ' Test User ', email: 'A@B.UZ', phone: '901234567' });
    expect(result).toEqual({ fullName: 'Test User', email: 'a@b.uz', phone: '+998901234567' });
  });

  it('reports invalid phone and email with translation keys', () => {
    const result = contactSchema.safeParse({ fullName: 'Test User', email: 'x', phone: '1' });
    expect(messages(result)).toEqual(expect.arrayContaining(['validation.emailInvalid', 'validation.phoneInvalid']));
  });
});

describe('createMemberSchema', () => {
  it('requires a known role', () => {
    const result = createMemberSchema.safeParse({ fullName: 'Test User', phone: '901234567', role: 'BOSS' });
    expect(result.success).toBe(false);
  });
});

describe('changePasswordSchema', () => {
  it('requires a long enough new password that differs from the old one', () => {
    expect(messages(changePasswordSchema.safeParse({ currentPassword: 'x', newPassword: 'short' }))).toContain(
      'validation.passwordTooShort',
    );
    expect(
      messages(changePasswordSchema.safeParse({ currentPassword: 'same-password-1', newPassword: 'same-password-1' })),
    ).toContain('validation.passwordMustDiffer');
  });
});

describe('companySettingsSchema', () => {
  it('accepts valid settings and normalizes the currency', () => {
    expect(companySettingsSchema.parse({ name: 'Test MEP', currency: 'uzs', timezone: 'Asia/Tashkent' })).toEqual({
      name: 'Test MEP',
      currency: 'UZS',
      timezone: 'Asia/Tashkent',
    });
  });

  it('rejects an unknown time zone', () => {
    const result = companySettingsSchema.safeParse({ name: 'Test MEP', currency: 'UZS', timezone: 'Mars/Base' });
    expect(messages(result)).toContain('validation.timezoneInvalid');
  });
});
