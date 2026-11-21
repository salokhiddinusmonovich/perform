import type { PayLine, PayResult } from '@puantaj/payroll';
import { describe, expect, it } from 'vitest';
import { columnSum, type Sheet } from './excel';
import type { FirmRef, PayrollPart, PayrollWorker } from './payroll';
import { payrollSheets, type PayrollExportInput } from './payroll-export';
import type { Formatters, Translate } from './payslip-text';

const t = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key}(${Object.values(options).join(',')})` : key) as unknown as Translate;
const format = {
  money: (v: string) => `${v} soʻm`,
  number: (v: string) => v,
  date: (v: string) => v,
} as unknown as Formatters;

const name = { lastName: 'Karimov', firstName: 'Aziz', patronymic: null, position: null };

const part = (lines: PayLine[], firm: PayrollPart['firm'] = undefined): PayrollPart => ({
  ruleSetName: '6-day week',
  firm,
  rulesFrom: { year: 2026, month: 3 },
  placementIds: ['p1'],
  places: { p1: { siteName: 'North', from: null, until: null } },
  salary: { monthlySalary: '5200000.00', from: '2026-01-01' },
  result: {
    source: 'DAILY',
    hourlyRate: {
      monthlySalary: '5200000.00',
      workingDays: { calculated: 26, override: null, effective: 26 },
      normalHoursPerDay: '8.00',
      rounded: '25000.00',
    },
    lines,
    total: lines.reduce((s, l) => s + Number(l.amount), 0).toFixed(2),
  } as unknown as PayResult,
});

const paid: PayrollWorker = {
  worker: { id: 'w1', employeeNumber: '101', ...name },
  positions: [{ from: '2026-03-01', until: '2026-03-31', name: 'Electrician' }],
  siteNames: ['North'],
  salary: { monthlySalary: '5200000.00', from: '2026-01-01' },
  source: 'DAILY',
  parts: [
    part([
      { type: 'HOURS', place: 'p1', kind: 'NORMAL', hours: '200.00', multiplier: '1.00', amount: '5000000.00' },
      { type: 'HOURS', place: 'p1', kind: 'OVERTIME', hours: '4.50', multiplier: '1.50', amount: '168750.00' },
      { type: 'ABSENCE', place: 'p1', absence: 'SICK', days: 1, paid: true, hoursPerDay: '8.00', hoursPerDaySource: 'SETTING', hours: '8.00', amount: '200000.00' },
      { type: 'TRAVEL_MONTHLY', amount: '300000.00' },
    ]),
  ],
  payOut: {
    earned: '5668750.00',
    adjustments: [
      { id: 'a1', type: 'BONUS', amount: '100000.00', note: null },
      { id: 'a2', type: 'ADVANCE', amount: '-1000000.00', note: 'cash 10.03' },
      { id: 'a3', type: 'ADVANCE', amount: '-500000.00', note: null },
    ],
    rounding: { step: '1000.00', amount: '250.00' },
    total: '4269000.00',
  },
  total: '4269000.00',
  problems: [],
};

const unpaid: PayrollWorker = {
  worker: { id: 'w2', employeeNumber: null, ...name, firstName: 'Bobur' },
  siteNames: ['South'],
  salary: null,
  source: null,
  parts: [],
  payOut: null,
  total: null,
  problems: [{ code: 'noSalary' }, { code: 'invalidHours', detail: 'day 3 twice' }],
};

const input = (over: Partial<PayrollExportInput> = {}): PayrollExportInput => ({
  month: { year: 2026, month: 3 },
  workers: [paid, unpaid],
  currency: 'UZS',
  t,
  format,
  departmentPaths: null,
  showFirms: false,
  categories: [],
  ...over,
});

const cell = (sheet: Sheet, row: number, header: string) => sheet.rows[row][sheet.columns.findIndex((c) => c.header === header)];

describe('payrollSheets', () => {
  it('gives every row as many cells as the sheet has columns, with departments, firms and categories too', () => {
    const categories = [{ id: 'c1', name: 'Direkt / Endirekt', isActive: true, options: [{ id: 'o1', name: 'Direkt', isActive: true }] }];
    for (const over of [{}, { departmentPaths: new Map(), showFirms: true, categories }]) {
      for (const sheet of payrollSheets(input(over))) {
        for (const row of sheet.rows) expect(row).toHaveLength(sheet.columns.length);
      }
    }
  });

  it('sums each payslip’s hours by kind and its pay by what it is for, adjustments by type', () => {
    const [summary] = payrollSheets(input());
    expect(summary.rows[0].slice(0, 3)).toEqual(['101', 'Karimov Aziz', 'Electrician']);
    expect(cell(summary, 0, 'payroll.hourKinds.NORMAL')).toBe('200.00');
    expect(cell(summary, 0, 'payroll.hourKinds.OVERTIME')).toBe('4.50');
    expect(cell(summary, 0, 'payroll.hourKinds.HOLIDAY')).toBeNull();
    expect(cell(summary, 0, 'payroll.export.hoursPay')).toBe('5168750.00');
    expect(cell(summary, 0, 'payroll.export.absencePay')).toBe('200000.00');
    expect(cell(summary, 0, 'payroll.export.travelPay')).toBe('300000.00');
    expect(cell(summary, 0, 'adjustments.types.ADVANCE')).toBe('-1500000.00');
    expect(cell(summary, 0, 'payroll.export.rounding')).toBe('250.00');
    expect(cell(summary, 0, 'payroll.payOutTotal')).toBe('4269000.00');
  });

  it('lists why a worker can’t be paid, and leaves their pay empty', () => {
    const [summary, details] = payrollSheets(input());
    expect(cell(summary, 1, 'payroll.payOutTotal')).toBeNull();
    expect(cell(summary, 1, 'payroll.export.problems')).toBe('payroll.problems.noSalary\npayroll.problems.invalidHours day 3 twice');
    expect(details.rows.every((row) => row[1] === 'Karimov Aziz')).toBe(true);
  });

  it('explains every line with its hours, rate and multiplier, then the pay-out', () => {
    const [, details] = payrollSheets(input());
    expect(details.rows.map((row) => row.slice(-4))).toEqual([
      ['200.00', '25000.00', '1.00', '5000000.00'],
      ['4.50', '25000.00', '1.50', '168750.00'],
      ['8.00', '25000.00', null, '200000.00'],
      [null, null, null, '300000.00'],
      [null, null, null, '5668750.00'],
      [null, null, null, '100000.00'],
      [null, null, null, '-1000000.00'],
      [null, null, null, '-500000.00'],
      [null, null, null, '250.00'],
      [null, null, null, '4269000.00'],
    ]);
    expect(cell(details, 6, 'payroll.export.line')).toBe('adjustments.types.ADVANCE: cash 10.03');
  });

  it('gives each firm’s payslip its own row', () => {
    const own: FirmRef = { id: 'f1', name: 'Own LLC', type: 'OWN' };
    const sub: FirmRef = { id: 'f2', name: 'Sub LLC', type: 'SUBCONTRACTOR' };
    const slip = (firm: FirmRef, total: string) => ({ firm, payOut: { earned: total, adjustments: [], rounding: null, total }, total });
    const twoFirms: PayrollWorker = {
      ...paid,
      firms: [own, sub],
      parts: [
        part([{ type: 'HOURS', place: 'p1', kind: 'NORMAL', hours: '100.00', multiplier: '1.00', amount: '2500000.00' }], own),
        part([{ type: 'HOURS', place: 'p1', kind: 'NORMAL', hours: '60.00', multiplier: '1.00', amount: '1500000.00' }], sub),
      ],
      payOut: null,
      payslips: [slip(own, '2500000.00'), slip(sub, '1500000.00')],
      total: '4000000.00',
    };
    const [summary] = payrollSheets(input({ workers: [twoFirms], showFirms: true }));
    expect(summary.rows.map((row) => [cell({ ...summary, rows: [row] }, 0, 'firms.firm'), cell({ ...summary, rows: [row] }, 0, 'payroll.hourKinds.NORMAL')])).toEqual([
      ['Own LLC', '100.00'],
      ['Sub LLC', '60.00'],
    ]);
    expect(columnSum(summary, summary.columns.findIndex((c) => c.header === 'payroll.payOutTotal'))).toBe('4000000.00');
  });
});
