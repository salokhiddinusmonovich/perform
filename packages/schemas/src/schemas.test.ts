import { describe, expect, it } from 'vitest';
import {
  changePasswordSchema,
  companySettingsSchema,
  contactSchema,
  createMemberSchema,
  createWorkerSchema,
  holidaySchema,
  NEW_PAY_RULES,
  normalizePhone,
  parseIdentifier,
  payRulesSchema,
  siteSchema,
  workerSchema,
  workingDaysOverrideSchema,
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

describe('payRulesSchema', () => {
  const valid = {
    ...NEW_PAY_RULES,
    restWeekdays: [7, 6, 7],
    normalHoursPerDay: '9',
    overtimeMultiplier: '1,5',
    restDayMultiplier: '2.00',
    holidayMultiplier: '2',
    travelPayMode: 'NONE' as const,
  };

  it('normalizes decimals, rest days and empty absence hours', () => {
    expect(payRulesSchema.parse(valid)).toEqual({
      restWeekdays: [6, 7],
      normalHoursPerDay: '9',
      overtimeMultiplier: '1.5',
      restDayMultiplier: '2',
      holidayMultiplier: '2',
      absence: {
        LEAVE: { paid: true, hoursPerDay: null },
        SICK: { paid: true, hoursPerDay: '8' },
        TRAVEL: { paid: true, hoursPerDay: null },
      },
      travelPayMode: 'NONE',
      payRoundingStep: '1000',
    });
  });

  it('starts a new company with the decided defaults only', () => {
    // Multipliers, normal hours and travel pay have no default: the admin must enter them.
    const result = payRulesSchema.safeParse(NEW_PAY_RULES);
    const paths = result.error?.issues.map((i) => i.path.join('.'));
    expect(paths).toEqual(
      expect.arrayContaining(['normalHoursPerDay', 'overtimeMultiplier', 'restDayMultiplier', 'holidayMultiplier', 'travelPayMode']),
    );
    expect(paths).not.toContain('absence.SICK.hoursPerDay');
  });

  it('reports bad values with translation keys', () => {
    const bad = (patch: object) => messages(payRulesSchema.safeParse({ ...valid, ...patch }));
    expect(bad({ normalHoursPerDay: '0' })).toEqual(['validation.normalHoursRange']);
    expect(bad({ normalHoursPerDay: '24.5' })).toEqual(['validation.normalHoursRange']);
    expect(bad({ overtimeMultiplier: '1.555' })).toEqual(['validation.decimalInvalid']);
    expect(bad({ overtimeMultiplier: 'x' })).toEqual(['validation.decimalInvalid']);
    expect(bad({ overtimeMultiplier: '-1' })).toEqual(['validation.decimalInvalid']);
    expect(bad({ holidayMultiplier: '100' })).toEqual(['validation.multiplierRange']);
    expect(bad({ restWeekdays: [1, 2, 3, 4, 5, 6, 7] })).toEqual(['validation.restWeekdaysAllWeek']);
    expect(bad({ payRoundingStep: '0' })).toEqual(['validation.roundingStepRange']);
    expect(payRulesSchema.parse({ ...valid, payRoundingStep: '1 000' }).payRoundingStep).toBe('1000');
    expect(bad({ absence: { ...valid.absence, SICK: { paid: true, hoursPerDay: '25' } } })).toEqual([
      'validation.hoursRange',
    ]);
  });
});

describe('holidaySchema', () => {
  it('accepts real days and turns an empty note into null', () => {
    expect(holidaySchema.parse({ date: '2028-02-29', kind: 'RAMAZON_HAYIT', name: ' ' })).toEqual({
      date: '2028-02-29',
      kind: 'RAMAZON_HAYIT',
      name: null,
    });
  });

  it('rejects days that do not exist', () => {
    for (const date of ['2026-02-29', '2026-13-01', '26-01-01', '1999-01-01']) {
      expect(messages(holidaySchema.safeParse({ date, kind: 'COMPANY_DAY_OFF' }))).toEqual(['validation.dateInvalid']);
    }
  });
});

describe('workingDaysOverrideSchema', () => {
  it('accepts a number of days or null (back to calculated)', () => {
    expect(workingDaysOverrideSchema.parse({ workingDays: 22, reason: '' })).toEqual({ workingDays: 22, reason: null });
    expect(workingDaysOverrideSchema.parse({ workingDays: null })).toEqual({ workingDays: null, reason: null });
    expect(messages(workingDaysOverrideSchema.safeParse({ workingDays: 0 }))).toEqual(['validation.workingDaysRange']);
  });
});

describe('the API accepts what a form sends', () => {
  // Forms submit the schema's output (zodResolver), and the API validates it again with
  // the same schema, so parsing an output must give the same output.
  it('pay rules, holidays and working-day overrides parse their own output', () => {
    const cases = [
      [
        payRulesSchema,
        {
          ...NEW_PAY_RULES,
          restWeekdays: [7],
          normalHoursPerDay: '9',
          overtimeMultiplier: '1,5',
          restDayMultiplier: '2',
          holidayMultiplier: '2',
          travelPayMode: 'NONE',
        },
      ],
      [holidaySchema, { date: '2026-03-20', kind: 'RAMAZON_HAYIT', name: '' }],
      [workingDaysOverrideSchema, { workingDays: 22, reason: '' }],
    ] as const;
    for (const [schema, input] of cases) {
      const once = schema.parse(input);
      expect(schema.parse(JSON.parse(JSON.stringify(once)))).toEqual(once);
    }
  });
});

describe('worker and placement schemas', () => {
  const worker = {
    lastName: ' Testov ',
    firstName: 'Test',
    patronymic: '',
    position: '',
    employmentType: 'DIRECT',
    pinfl: '1234 5678 9012 34',
    birthDate: '1985-02-28',
    nationality: '',
    passportSeries: 'ab',
    passportNumber: '',
    phone: '',
  } as const;

  it('normalizes a worker and accepts its own output', () => {
    const once = createWorkerSchema.parse({
      worker,
      placement: { siteId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', teamId: '', from: '2026-09-01', shift: 'DAY' },
    });
    expect(once.worker).toMatchObject({ lastName: 'Testov', pinfl: '12345678901234', passportSeries: 'AB', phone: null, patronymic: null });
    expect(once.placement.teamId).toBeNull();
    expect(createWorkerSchema.parse(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it('checks PINFL and dates', () => {
    expect(messages(workerSchema.safeParse({ ...worker, pinfl: '123' }))).toEqual(['validation.pinflInvalid']);
    expect(messages(workerSchema.safeParse({ ...worker, birthDate: '1985-02-30' }))).toEqual(['validation.dateInvalid']);
    expect(messages(siteSchema.safeParse({ name: ' ' }))).toEqual(['validation.required']);
  });
});
