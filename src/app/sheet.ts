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

function isUnnamed(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== "string") return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code !== 0x20 && code !== 0x09) return false;
  }
  return true;
}

function claimHeaderName(candidate: string, used: Map<string, number>): string {
  let name = candidate;
  for (;;) {
    const key = name.toLowerCase();
    const count = used.get(key);
    if (count === undefined) {
      used.set(key, 0);
      return name;
    }
    used.set(key, count + 1);
    name = `${name}_${count + 1}`;
  }
}

export function excelHeaderNames(values: readonly unknown[], width: number): string[] {
  const used = new Map<string, number>();
  const names: string[] = [];
  for (let index = 0; index < width; index++) {
    const flat = flattenCell(values[index]);
    const candidate = isUnnamed(flat) ? `column${index}` : String(flat);
    names.push(claimHeaderName(candidate, used));
  }
  return names;
}

export async function firstSheetAsCsv(file: File): Promise<string> {
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
  const data = rows.slice(1).map((values) =>
    Array.from({ length: width }, (_, index) => flattenCell(values[index])),
  );
  return toCsv(header, data);
}
