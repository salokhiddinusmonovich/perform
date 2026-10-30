import type { ImportField, ImportMapping, YearMonth } from '@puantaj/schemas';
import { api } from '@/lib/api';

/**
 * Why a row (or, with row null, the whole file) can't be imported. `code` is shown as
 * `errors.<code>`, or as itself for validation.* keys.
 */
export interface ImportProblem {
  row: number | null;
  employeeNumber: string | null;
  name: string | null;
  code: string;
  field?: ImportField;
  value?: string;
  days?: number[];
}

/** Where the file differs from a worker already in the app (the import changes nothing of theirs). */
export interface ImportWorkerChange {
  row: number;
  employeeNumber: string;
  name: string;
  field: 'site' | 'department' | 'leftOn' | 'salary';
  file: string | null;
  app: string | null;
}

export interface ImportPreview {
  fileName: string;
  sheetNames: string[];
  /** The sheet read; null: no sheet has day columns */
  sheet: string | null;
  headerRow: number | null;
  headers: string[];
  days: number[];
  mapping: ImportMapping;
  /** The mapping is the one saved with the company's last import */
  mappingSaved: boolean;
  /** Values found for each fixed choice (folded), to map each one */
  values: { employmentType: string[] };
  locked: boolean;
  workers: {
    rows: number;
    new: number;
    existing: number;
    problems: ImportProblem[];
    /** What the import read differently from the file's columns; never blocks it */
    notes: ImportProblem[];
    changes: ImportWorkerChange[];
  };
  hours: {
    workers: number;
    replaces: number;
    problems: ImportProblem[];
    /** Blank cells read as unexcused absences (when the company chose so); never blocks it */
    notes: ImportProblem[];
  };
  earlier: { id: string; fileName: string; workers: number; createdAt: string; createdBy: { fullName: string } }[];
}

export interface ImportRequest {
  file: File;
  month: YearMonth;
  sheet?: string;
  /** Absent: the company's saved mapping, or guessed columns */
  mapping?: ImportMapping;
}

function form({ file, month, sheet, mapping }: ImportRequest): FormData {
  const data = new FormData();
  data.append('year', String(month.year));
  data.append('month', String(month.month));
  if (sheet) data.append('sheet', sheet);
  if (mapping) data.append('mapping', JSON.stringify(mapping));
  data.append('file', file);
  return data;
}

export const previewImport = (request: ImportRequest) => api.upload<ImportPreview>('/imports/preview', form(request));
export const importWorkers = (request: ImportRequest) => api.upload<{ created: number }>('/imports/workers', form(request));
export const importHours = (request: ImportRequest) =>
  api.upload<{ importId: string; workers: number }>('/imports/hours', form(request));
