import { z } from 'zod';
import { EMPLOYMENT_TYPES } from './organisation.js';
import { monthSchema, yearSchema } from './pay-rules.js';

// Excel import of a month's sheet (AGENTS.md: Excel import).

/**
 * What a column of the sheet can hold, besides the day columns 1…31 (found by their
 * header). The worker's details go to the workers step; the shift is checked by the hours
 * step.
 */
export const IMPORT_FIELDS = [
  'employeeNumber',
  'lastName',
  'firstName',
  'patronymic',
  'position',
  'employmentType',
  'pinfl',
  'birthDate',
  'nationality',
  'passportSeries',
  'passportNumber',
  'phone',
  'site',
  'department',
  'firm',
  'hiredOn',
  'leftOn',
  'salary',
  'shift',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

/**
 * Columns the workers step needs. The department and the firm are needed too while the
 * company uses them; the API adds them.
 */
export const WORKER_IMPORT_REQUIRED = [
  'employeeNumber',
  'lastName',
  'firstName',
  'employmentType',
  'site',
  'hiredOn',
] as const satisfies readonly ImportField[];

/** The hours step needs only the employee number, besides the day columns. */
export const HOURS_IMPORT_REQUIRED = ['employeeNumber'] as const satisfies readonly ImportField[];

const headerText = z.string().trim().min(1, { error: 'validation.required' }).max(200, { error: 'validation.tooLong' });

/**
 * What a blank day cell means while the worker is employed: a problem row (the file is
 * corrected), or an unexcused absence (AGENTS.md: Excel import).
 */
export const BLANK_CELL_READINGS = ['PROBLEM', 'ABSENT'] as const;
export type BlankCellReading = (typeof BLANK_CELL_READINGS)[number];

/**
 * How a company's sheet is read: the header text of each field's column, what the file's
 * values of a fixed choice stand for (keyed by the value folded with foldText()), and what
 * a blank day cell means. Saved per company by each import and offered for the next one.
 * Mappings saved before blank cells could be read as absences read them as problems.
 */
export const importMappingSchema = z.object({
  columns: z.partialRecord(z.enum(IMPORT_FIELDS), headerText),
  values: z.object({
    employmentType: z.record(z.string().max(200), z.enum(EMPLOYMENT_TYPES)),
  }),
  blankCells: z.enum(BLANK_CELL_READINGS, { error: 'validation.invalid' }).default('PROBLEM'),
});
export type ImportMappingInput = z.input<typeof importMappingSchema>;
export type ImportMapping = z.output<typeof importMappingSchema>;

/**
 * The form fields sent with the file (multipart, so every value is text). Without a
 * mapping the API uses the company's saved one, and guesses the columns it doesn't name.
 */
export const importRequestSchema = z.object({
  year: yearSchema,
  month: monthSchema,
  /** The sheet to read; absent: the first one with day columns */
  sheet: z.string().trim().max(200).optional(),
  mapping: z
    .string()
    .optional()
    .transform((text, ctx) => {
      if (text === undefined || text === '') return undefined;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'validation.invalid' });
        return z.NEVER;
      }
    })
    .pipe(importMappingSchema.optional()),
});
export type ImportRequestInput = z.input<typeof importRequestSchema>;
export type ImportRequest = z.output<typeof importRequestSchema>;

/**
 * Folds text for matching names and values from a file: trimmed, single spaces, upper
 * case, Turkish letters as their plain Latin ones (İ/I/ı → I, Ş → S…), so "Gunduz",
 * "GÜNDÜZ" and "gündüz " match. Codes use normalizeCode() in @puantaj/payroll instead.
 */
export function foldText(raw: string): string {
  return raw
    .replace(/[İıi]/g, 'I')
    .toUpperCase()
    .replace(/Ş/g, 'S')
    .replace(/Ç/g, 'C')
    .replace(/Ğ/g, 'G')
    .replace(/Ü/g, 'U')
    .replace(/Ö/g, 'O')
    .replace(/\s+/g, ' ')
    .trim();
}
