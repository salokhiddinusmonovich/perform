import { fromUnits, toUnits } from '@puantaj/payroll';

// Excel files the app writes for download. Sheets are built as plain data (testable without a
// browser) and written here; exceljs is loaded only when a file is downloaded.

/** text: as is; money and number: a decimal string from the API, written as a number. */
export type ColumnKind = 'text' | 'money' | 'number';

export interface SheetColumn {
  header: string;
  kind: ColumnKind;
  /** Width in characters */
  width: number;
  /** Added up in the sheet's total row (money and number columns) */
  sum?: boolean;
  /** Text that may run over several lines */
  wrap?: boolean;
}

/** A cell: text, or a decimal string in money and number columns; null: empty. */
export type SheetCell = string | null;

export interface Sheet {
  name: string;
  columns: SheetColumn[];
  rows: SheetCell[][];
  /** Label of a last row with the sums of the columns that have them; absent: no total row */
  totalLabel?: string;
}

const NUMBER_FORMAT: Record<Exclude<ColumnKind, 'text'>, string> = {
  money: '#,##0.00',
  number: '#,##0.##',
};

/** The exact sum of a column's decimal strings. */
export function columnSum(sheet: Sheet, index: number): string {
  return fromUnits(sheet.rows.reduce((sum, row) => (row[index] ? sum + toUnits(row[index]!) : sum), 0n));
}

/** Writes the sheets into an .xlsx file and has the browser save it. */
export async function downloadExcel(sheets: Sheet[], fileName: string): Promise<void> {
  const { Workbook } = await import('exceljs');
  const workbook = new Workbook();
  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = sheet.columns.map((c) => ({
      header: c.header,
      width: c.width,
      style:
        c.kind !== 'text'
          ? { numFmt: NUMBER_FORMAT[c.kind] }
          : c.wrap
            ? { alignment: { vertical: 'top', wrapText: true } }
            : {},
    }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { vertical: 'top', wrapText: true };
    for (const row of sheet.rows) {
      ws.addRow(row.map((cell, i) => (cell === null ? null : sheet.columns[i].kind === 'text' ? cell : Number(cell))));
    }
    if (sheet.totalLabel !== undefined && sheet.rows.length > 0) {
      const first = 2;
      const last = sheet.rows.length + 1;
      const total = ws.addRow(
        sheet.columns.map((c, i) => {
          if (i === 0) return sheet.totalLabel;
          if (!c.sum) return null;
          const letter = ws.getColumn(i + 1).letter;
          return { formula: `SUM(${letter}${first}:${letter}${last})`, result: Number(columnSum(sheet, i)) };
        }),
      );
      total.font = { bold: true };
    }
  }
  const buffer = await workbook.xlsx.writeBuffer();
  const url = URL.createObjectURL(
    new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // Some browsers start reading the file only after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
