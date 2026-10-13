import { toCsv } from "./files.ts";

function flattenCell(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== "object" || value === null) return value;
  const cell = value as { result?: unknown; text?: unknown; richText?: { text: string }[] };
  if (cell.richText) return cell.richText.map((part) => part.text).join("");
  if ("result" in cell) return flattenCell(cell.result);
  if ("text" in cell) return cell.text;
  return "";
}

export function excelHeaderNames(values: readonly unknown[], width: number): string[] {
  const names: string[] = [];
  for (let index = 0; index < width; index++) {
    names.push(String(flattenCell(values[index])));
  }
  return names;
}

// A hole is a missing cell. Null, a blank string, and whitespace stay as written.
export function excelHoleIndexes(values: readonly unknown[], width: number): number[] {
  const holes: number[] = [];
  for (let index = 0; index < width; index++) {
    if (flattenCell(values[index]) === undefined) holes.push(index);
  }
  return holes;
}

// DuckDB folds only A-Z when it settles a duplicate header.
function asciiFold(name: string): string {
  let folded = "";
  for (const char of name) {
    const code = char.charCodeAt(0);
    folded += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : char;
  }
  return folded;
}

export function holeRenames(
  columnNames: readonly string[],
  holes: readonly number[],
): { index: number; from: string; to: string }[] {
  const used = new Set(columnNames.map(asciiFold));
  const renames: { index: number; from: string; to: string }[] = [];
  for (const index of [...holes].sort((left, right) => left - right)) {
    if (!Number.isInteger(index) || index < 0 || index >= columnNames.length) {
      throw new RangeError(`Column ${index} is outside the loaded table`);
    }
    const from = columnNames[index];
    used.delete(asciiFold(from));
    let to = `column${index}`;
    let suffix = 1;
    while (used.has(asciiFold(to))) {
      to = `column${index}_${suffix}`;
      suffix += 1;
    }
    used.add(asciiFold(to));
    renames.push({ index, from, to });
  }
  return renames;
}

export async function firstSheetAsCsv(file: File): Promise<{ csv: string; holes: readonly number[] }> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount < 2) throw new Error("The first sheet of that workbook has no data rows.");
  const width = sheet.columnCount;
  const rows: unknown[][] = [];
  sheet.eachRow((row) => {
    const values = (row.values as unknown[]).slice(1);
    rows.push(values);
  });
  const header = excelHeaderNames(rows[0], width);
  const holes = excelHoleIndexes(rows[0], width);
  const data = rows.slice(1).map((values) =>
    Array.from({ length: width }, (_, index) => flattenCell(values[index])),
  );
  return { csv: toCsv(header, data), holes };
}
