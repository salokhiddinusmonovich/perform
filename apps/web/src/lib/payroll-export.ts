import { fromUnits, toUnits, type HourKind } from '@puantaj/payroll';
import type { YearMonth } from '@puantaj/schemas';
import type { Sheet, SheetCell, SheetColumn } from './excel';
import { workerName, type WorkerCategoryItem } from './organisation';
import { payrollSiteNames, payslipsOf, type PayrollPart, type PayrollWorker } from './payroll';
import {
  partHeading,
  payLineText,
  payOutLines,
  placeText,
  positionsText,
  problemText,
  type Formatters,
  type Translate,
} from './payslip-text';

// The month's pay as an Excel file: a summary row per payslip, and every line of every payslip
// with the hours, rate and rule it came from (AGENTS.md: Payroll must be explainable).

const HOUR_KINDS: readonly HourKind[] = ['NORMAL', 'OVERTIME', 'REST_DAY', 'HOLIDAY'];

export interface PayrollExportInput {
  month: YearMonth;
  /** The workers to export, in the order on screen */
  workers: readonly PayrollWorker[];
  currency: string;
  t: Translate;
  format: Formatters;
  /** Department paths by id, while the company uses departments; null: it doesn't */
  departmentPaths: ReadonlyMap<string, string> | null;
  /** Whether the company uses firms */
  showFirms: boolean;
  /** The categories to give a column each */
  categories: readonly WorkerCategoryItem[];
}

/** Exact sum of decimal strings; null for none, so an empty cell stays empty. */
function sum(values: readonly string[]): string | null {
  return values.length === 0 ? null : fromUnits(values.reduce((total, v) => total + toUnits(v), 0n));
}

export function payrollSheets(input: PayrollExportInput): Sheet[] {
  const { workers, currency, t, format, departmentPaths, showFirms, categories } = input;

  /** The columns that name the worker, in both sheets. */
  const workerColumns: SheetColumn[] = [
    { header: t('workers.employeeNumber'), kind: 'text', width: 12 },
    { header: t('workers.name'), kind: 'text', width: 32 },
  ];
  const workerCells = (w: PayrollWorker): SheetCell[] => [w.worker.employeeNumber ?? null, workerName(w.worker)];

  /** What a payslip pays: empty for a worker who can't be paid yet. */
  const PAY_COLUMNS: SheetColumn[] = [
    ...HOUR_KINDS.map((kind) => ({ header: t(`payroll.hourKinds.${kind}`), kind: 'number', width: 12, sum: true }) as const),
    { header: t('payroll.export.hoursPay'), kind: 'money', width: 16, sum: true },
    { header: t('payroll.export.absencePay'), kind: 'money', width: 16, sum: true },
    { header: t('payroll.export.travelPay'), kind: 'money', width: 16, sum: true },
    { header: t('payroll.earned'), kind: 'money', width: 16, sum: true },
    { header: t('adjustments.types.BONUS'), kind: 'money', width: 14, sum: true },
    { header: t('adjustments.types.ADVANCE'), kind: 'money', width: 14, sum: true },
    { header: t('adjustments.types.DEDUCTION'), kind: 'money', width: 14, sum: true },
    { header: t('payroll.export.rounding'), kind: 'money', width: 12, sum: true },
    { header: t('payroll.payOutTotal'), kind: 'money', width: 16, sum: true },
  ];

  const summaryColumns: SheetColumn[] = [
    ...workerColumns,
    { header: t('workers.position'), kind: 'text', width: 24 },
    ...(departmentPaths ? [{ header: t('departments.department'), kind: 'text', width: 24 } as const] : []),
    ...(showFirms
      ? ([
          { header: t('firms.firm'), kind: 'text', width: 24 },
          { header: t('firms.type'), kind: 'text', width: 14 },
        ] as const)
      : []),
    { header: t('workers.site'), kind: 'text', width: 24 },
    ...categories.map((c) => ({ header: c.name, kind: 'text', width: 16 }) as const),
    { header: t('workers.salary'), kind: 'money', width: 16 },
    { header: t('payroll.source'), kind: 'text', width: 16 },
    ...PAY_COLUMNS,
    { header: t('payroll.export.problems'), kind: 'text', width: 48, wrap: true },
  ];

  const detailColumns: SheetColumn[] = [
    ...workerColumns,
    ...(showFirms ? [{ header: t('firms.firm'), kind: 'text', width: 24 } as const] : []),
    { header: t('payroll.export.part'), kind: 'text', width: 40 },
    { header: t('workers.site'), kind: 'text', width: 24 },
    { header: t('payroll.export.line'), kind: 'text', width: 48 },
    { header: t('payroll.export.hours'), kind: 'number', width: 10 },
    { header: t('payroll.export.hourlyRate'), kind: 'money', width: 14 },
    { header: t('payroll.export.multiplier'), kind: 'number', width: 12 },
    { header: t('payroll.export.amount'), kind: 'money', width: 16 },
  ];

  const summary: SheetCell[][] = [];
  const details: SheetCell[][] = [];

  for (const w of workers) {
    // The positions with their days, as on the payslip; a month locked before positions were a list has the worker's own.
    const position = (w.positions ? positionsText(w, t, format) : w.worker.position) || null;
    const describe: SheetCell[] = [
      position,
      ...(departmentPaths ? [w.department ? (departmentPaths.get(w.department.id) ?? w.department.name) : null] : []),
    ];
    const sites = payrollSiteNames(w).join(', ') || null;
    const categoryCells = categories.map((c) => {
      const optionId = w.categories?.[c.id];
      return optionId ? (c.options.find((o) => o.id === optionId)?.name ?? null) : null;
    });
    const source = w.source ? t(`payroll.sources.${w.source}`) : null;

    if (w.problems.length > 0) {
      const problems = w.problems
        .map((p) => {
          const { text, details: more } = problemText(p, t, format, categories);
          return [text, ...more].join(' ');
        })
        .join('\n');
      summary.push([
        ...workerCells(w),
        ...describe,
        ...(showFirms ? [w.firms?.map((f) => f.name).join(', ') || null, null] : []),
        sites,
        ...categoryCells,
        w.salary?.monthlySalary ?? null,
        source,
        ...PAY_COLUMNS.map(() => null),
        problems,
      ]);
      continue;
    }

    for (const slip of payslipsOf(w)) {
      const lines = slip.parts.flatMap((p) => p.result.lines);
      const amounts = (...types: string[]) => lines.filter((l) => types.includes(l.type)).map((l) => l.amount);
      const adjustments = (type: string) => slip.payOut.adjustments.filter((a) => a.type === type).map((a) => a.amount);
      const lastPart: PayrollPart | undefined = slip.parts.at(-1);
      summary.push([
        ...workerCells(w),
        ...describe,
        ...(showFirms ? [slip.firm?.name ?? null, slip.firm ? t(`firms.types.${slip.firm.type}`) : null] : []),
        sites,
        ...categoryCells,
        lastPart?.salary?.monthlySalary ?? slip.salary?.monthlySalary ?? w.salary?.monthlySalary ?? null,
        source,
        ...HOUR_KINDS.map((kind) => sum(lines.flatMap((l) => (l.type === 'HOURS' && l.kind === kind ? [l.hours] : [])))),
        sum(amounts('HOURS')),
        sum(amounts('ABSENCE')),
        sum(amounts('TRAVEL_PER_DAY', 'TRAVEL_MONTHLY')),
        slip.payOut.earned,
        sum(adjustments('BONUS')),
        sum(adjustments('ADVANCE')),
        sum(adjustments('DEDUCTION')),
        slip.payOut.rounding?.amount ?? null,
        slip.payOut.total,
        null,
      ]);

      const firmCell: SheetCell[] = showFirms ? [slip.firm?.name ?? null] : [];
      const row = (part: string | null, place: string | null, line: string, hours: string | null, rate: string | null, multiplier: string | null, amount: string) =>
        details.push([...workerCells(w), ...firmCell, part, place, line, hours, rate, multiplier, amount]);
      for (const part of slip.parts) {
        const heading = partHeading(part, t, format);
        const rate = part.result.hourlyRate.rounded;
        for (const line of part.result.lines) {
          row(
            heading,
            'place' in line ? placeText(part, line.place, t, format) : null,
            payLineText(line, t, format, currency),
            line.type === 'HOURS' || line.type === 'ABSENCE' ? line.hours : null,
            line.type === 'HOURS' || line.type === 'ABSENCE' ? rate : null,
            line.type === 'HOURS' ? line.multiplier : null,
            line.amount,
          );
        }
      }
      row(null, null, t('payroll.earned'), null, null, null, slip.payOut.earned);
      for (const line of payOutLines(slip.payOut, t, format, currency)) {
        row(null, null, line.note ? `${line.label}: ${line.note}` : line.label, null, null, null, line.amount);
      }
      row(null, null, t('payroll.payOutTotal'), null, null, null, slip.payOut.total);
    }
  }

  return [
    { name: t('payroll.export.summarySheet'), columns: summaryColumns, rows: summary, totalLabel: t('payroll.export.total') },
    { name: t('payroll.export.detailsSheet'), columns: detailColumns, rows: details },
  ];
}

/** e.g. "Pay calculation 2026-11.xlsx" */
export function payrollFileName({ year, month }: YearMonth, t: Translate): string {
  return `${t('payroll.title')} ${year}-${String(month).padStart(2, '0')}.xlsx`;
}
