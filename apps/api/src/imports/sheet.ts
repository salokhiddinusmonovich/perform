import ExcelJS from 'exceljs';
import { foldText, IMPORT_FIELDS, type ImportField, type ImportMapping } from '@puantaj/schemas';
import { badRequest } from '../common/api-error';

/** A cell's value as the import reads it: formulas give their result, rich text its text. */
export type Cell = string | number | Date | null;

/** One sheet of a workbook, with the header row found in it. */
export interface Sheet {
  name: string;
  /** Excel row number of the header row */
  headerRow: number;
  /** Header cells that aren't day columns, in column order */
  headers: { column: number; text: string }[];
  /** Day of the month → column number, from header cells 1…31 */
  dayColumns: Map<number, number>;
  /** The rows below the header, with their Excel row numbers */
  rows: { row: number; cells: Cell[] }[];
}

/** How many rows from the top are searched for the header row. */
const HEADER_SEARCH_ROWS = 30;

/**
 * Reads an .xlsx file. Only sheets with day columns (a header row with the days 1…28 at
 * least) can be imported; the others are listed by name only.
 */
export async function readWorkbook(file: Buffer): Promise<{ sheetNames: string[]; sheets: Sheet[] }> {
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs's types predate Buffer being generic in @types/node.
    await workbook.xlsx.load(file as unknown as ArrayBuffer);
  } catch {
    throw badRequest('import.unreadableFile');
  }
  const date1904 = Boolean(workbook.properties?.date1904);
  const sheets: Sheet[] = [];
  for (const ws of workbook.worksheets) {
    const grid: { row: number; cells: Cell[] }[] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells: Cell[] = [];
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        cells[col] = cellValue(cell.value, date1904);
      });
      grid.push({ row: rowNumber, cells });
    });
    const sheet = findHeader(ws.name, grid);
    if (sheet) sheets.push(sheet);
  }
  return { sheetNames: workbook.worksheets.map((ws) => ws.name), sheets };
}

function cellValue(value: ExcelJS.CellValue, date1904: boolean): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if ('result' in value) return cellValue((value.result ?? null) as ExcelJS.CellValue, date1904);
    if ('richText' in value) return value.richText.map((r) => r.text).join('');
    if ('text' in value) return String(value.text);
    if ('error' in value) return String(value.error);
  }
  return null;
}

/** The day a header cell names (1…31), or null. A date header names its day of the month. */
function headerDay(cell: Cell): number | null {
  if (cell instanceof Date) return cell.getUTCDate();
  const text = typeof cell === 'number' ? String(cell) : typeof cell === 'string' ? cell.trim() : '';
  if (!/^\d{1,2}$/.test(text)) return null;
  const day = Number(text);
  return day >= 1 && day <= 31 ? day : null;
}

function findHeader(name: string, grid: { row: number; cells: Cell[] }[]): Sheet | null {
  for (const { row, cells } of grid.slice(0, HEADER_SEARCH_ROWS)) {
    const dayColumns = new Map<number, number>();
    cells.forEach((cell, col) => {
      const day = headerDay(cell);
      if (day !== null && !dayColumns.has(day)) dayColumns.set(day, col);
    });
    if (![...Array(28).keys()].every((i) => dayColumns.has(i + 1))) continue;
    const days = new Set(dayColumns.values());
    const headers = cells.flatMap((cell, column) => {
      if (days.has(column) || cell === null) return [];
      const text = (cell instanceof Date ? cell.toISOString().slice(0, 10) : String(cell)).replace(/\s+/g, ' ').trim();
      return text ? [{ column, text }] : [];
    });
    return { name, headerRow: row, headers, dayColumns, rows: grid.filter((r) => r.row > row) };
  }
  return null;
}

/** A cell as trimmed text; numbers as written (no exponent for whole numbers), null when blank. */
export function cellText(cell: Cell): string | null {
  if (cell === null) return null;
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  if (typeof cell === 'number') return Number.isInteger(cell) ? BigInt(cell).toString() : String(cell);
  const text = cell.replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

/**
 * A date cell as "YYYY-MM-DD": a date-formatted cell, an Excel serial day number, or text
 * written as DD.MM.YYYY, DD/MM/YYYY or YYYY-MM-DD. Anything else is 'invalid'.
 */
export function cellDate(cell: Cell): string | null | 'invalid' {
  if (cell === null) return null;
  let date: Date | null = null;
  if (cell instanceof Date) date = cell;
  else if (typeof cell === 'number') {
    // Serial day numbers count from 1899-12-30 (Excel's 1900 date system, which is the default).
    if (Number.isInteger(cell) && cell > 0 && cell < 2958466) date = new Date(Date.UTC(1899, 11, 30) + cell * 86_400_000);
  } else {
    const text = cell.trim();
    if (text === '') return null;
    let m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(text);
    if (m) date = utcDate(Number(m[3]), Number(m[2]), Number(m[1]));
    m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (m) date = utcDate(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : 'invalid';
}

/** A real calendar day, or null (e.g. 31.02). */
function utcDate(year: number, month: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

/**
 * Words a header of each field's column usually has, in the languages of our customers'
 * files, folded with foldText(). A header matches when it contains one of them as whole
 * words. Fields are guessed in this order and each column is used once, so the more
 * specific ones (patronymic "BABA ADI") come before the ones they contain (first name "ADI").
 */
const GUESSES: [ImportField, string[]][] = [
  ['employeeNumber', ['SICIL', 'SICIL NO', 'TABEL', 'TABEL NO', 'ТАБЕЛЬНЫЙ', 'ТАБ №', 'EMPLOYEE NO', 'EMPLOYEE NUMBER', 'PERSONEL NO']],
  ['patronymic', ['BABA ADI', 'ОТЧЕСТВО', 'OTASINING ISMI', 'SHARIFI', 'PATRONYMIC', 'MIDDLE NAME']],
  ['lastName', ['SOYADI', 'SOYAD', 'ФАМИЛИЯ', 'FAMILIYA', 'FAMILIYASI', 'LAST NAME', 'SURNAME']],
  ['firstName', ['ADI', 'AD', 'ИМЯ', 'ISM', 'ISMI', 'FIRST NAME', 'NAME']],
  ['position', ['GOREV', 'GOREVI', 'ДОЛЖНОСТЬ', 'LAVOZIM', 'LAVOZIMI', 'POSITION', 'UNVAN']],
  ['pinfl', ['ПИНФЛ', 'PINFL', 'JSHSHIR']],
  ['birthDate', ['ДАТА РОЖДЕНИЯ', 'DOGUM TARIHI', 'TUGILGAN SANA', 'BIRTH DATE', 'DATE OF BIRTH']],
  ['nationality', ['MENSEI', 'UYRUK', 'УЙРУК', 'НАЦИОНАЛЬНОСТЬ', 'ГРАЖДАНСТВО', 'MILLATI', 'FUQAROLIGI', 'NATIONALITY']],
  ['passportSeries', ['PASS СЕРИЯ', 'СЕРИЯ ПАСПОРТА', 'СЕРИЯ', 'PASAPORT SERI', 'PASSPORT SERIES', 'SERIYA']],
  ['passportNumber', ['PASS №', 'PASS NO', 'НОМЕР ПАСПОРТА', 'PASAPORT NO', 'PASSPORT NO', 'PASSPORT NUMBER']],
  ['phone', ['CONTACT NUMBER', 'ТЕЛЕФОН', 'TELEFON', 'PHONE', 'КОНТАКТ']],
  ['site', ['ОБЪЕКТ', 'SANTIYE', 'OBYEKT', 'SITE', 'PROJE']],
  ['department', ['ПОДРАЗДЕЛЕНИЕ', 'EKIB', 'EKIP', 'BOLUM', 'BOLIM', 'DEPARTMENT', 'ОТДЕЛ']],
  ['firm', ['ФИРМА', 'FIRMA', 'FIRM', 'KOMPANIYA', 'SIRKET']],
  ['hiredOn', ['GIRIS TARIHI', 'ДАТА ПРИЕМА', 'ДАТА ПРИЁМА', 'ISHGA KIRGAN', 'HIRE DATE', 'START DATE']],
  ['leftOn', ['CIKIS TARIHI', 'УВОЛЬН', 'ДАТА УВОЛЬНЕНИЯ', 'ISHDAN BOSHAGAN', 'EXIT DATE', 'END DATE']],
  ['salary', ['UCRET', 'MAAS', 'ОКЛАД', 'SALARY', 'MONTHLY SALARY']],
  ['shift', ['СМЕНА', 'VARDIYA', 'SMENA', 'SHIFT']],
];

/** A header folded into words for matching: punctuation (but №) between words becomes a space. */
const headerWords = (text: string) => ` ${foldText(text.replace(/[_\-/\\().,:;]+/g, ' '))} `;

/**
 * The mapping to use for a sheet: each field's and each active worker category's column
 * from `preferred` (sent with the request, or the company's saved mapping) where the sheet
 * has that header. Without one, every column is guessed: a category's from a header that
 * holds its name, the fields' from GUESSES. Value mappings are kept as they are.
 */
export function mappingFor(
  sheet: Sheet,
  preferred: ImportMapping | null,
  categories: readonly { id: string; name: string }[],
): ImportMapping {
  const columns: ImportMapping['columns'] = {};
  const mapped: ImportMapping['categories'] = {};
  const used = new Set<number>();
  const texts = new Map(sheet.headers.map((h) => [foldText(h.text), h]));
  const take = (text: string | undefined) => {
    const header = text === undefined ? undefined : texts.get(foldText(text));
    if (!header || used.has(header.column)) return null;
    used.add(header.column);
    return header.text;
  };
  for (const field of IMPORT_FIELDS) {
    const text = take(preferred?.columns[field]);
    if (text !== null) columns[field] = text;
  }
  for (const { id } of categories) {
    const own = preferred?.categories[id];
    const text = take(own?.column);
    if (text !== null) mapped[id] = { column: text, values: { ...own!.values } };
  }
  // A mapping sent or saved is the user's: a column they left out stays out.
  if (!preferred) {
    // Category names are the company's own, so more specific than the usual words.
    for (const { id, name } of categories) {
      const header = sheet.headers.find((h) => !used.has(h.column) && headerWords(h.text).includes(headerWords(name)));
      if (header) {
        mapped[id] = { column: header.text, values: {} };
        used.add(header.column);
      }
    }
    for (const [field, words] of GUESSES) {
      if (columns[field] !== undefined) continue;
      const header = sheet.headers.find(
        (h) => !used.has(h.column) && words.some((w) => headerWords(h.text).includes(` ${foldText(w)} `)),
      );
      if (header) {
        columns[field] = header.text;
        used.add(header.column);
      }
    }
  }
  return { columns, categories: mapped, blankCells: preferred?.blankCells ?? 'PROBLEM' };
}

/** A guess of the option a file's value (folded) stands for: the one with that name, or null. */
export function guessOption<O extends { id: string; name: string }>(options: readonly O[], folded: string): O | null {
  return options.find((o) => foldText(o.name) === folded) ?? null;
}

/** Column number of each mapped field (fields whose header isn't in the sheet are left out). */
export function columnsOf(sheet: Sheet, mapping: ImportMapping): Partial<Record<ImportField, number>> {
  const out: Partial<Record<ImportField, number>> = {};
  for (const field of IMPORT_FIELDS) {
    const text = mapping.columns[field];
    if (text === undefined) continue;
    const header = sheet.headers.find((h) => foldText(h.text) === foldText(text));
    if (header) out[field] = header.column;
  }
  return out;
}

/** Column number of each mapped worker category, by category id (as columnsOf()). */
export function categoryColumnsOf(sheet: Sheet, mapping: ImportMapping): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, { column }] of Object.entries(mapping.categories)) {
    const header = sheet.headers.find((h) => foldText(h.text) === foldText(column));
    if (header) out.set(id, header.column);
  }
  return out;
}
