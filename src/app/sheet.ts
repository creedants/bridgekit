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

export async function firstSheetAsCsv(file: File): Promise<{ csv: string; holes: readonly number[]; formulaBlanks: number }> {
  const { default: ExcelJS } = await import("exceljs");
  const data = await file.arrayBuffer();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data);
  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount < 2) throw new Error("The first sheet of that workbook has no data rows.");
  const width = sheet.columnCount;
  const rows: unknown[][] = [];
  const rowNumbers: number[] = [];
  sheet.eachRow((row, rowNumber) => {
    const values = (row.values as unknown[]).slice(1);
    rows.push(values);
    rowNumbers.push(rowNumber);
  });
  const header = excelHeaderNames(rows[0], width);
  const holes = excelHoleIndexes(rows[0], width);
  const dataRows = rows.slice(1).map((values) =>
    Array.from({ length: width }, (_, index) => flattenCell(values[index])),
  );
  return { csv: toCsv(header, dataRows), holes, formulaBlanks: await countFormulaBlanks(data, rowNumbers.slice(1)) };
}

// A formula cell with no `<v>` in the sheet XML has no cached result, so the
// reader loads it as blank. A cached empty string still writes `<v></v>`, so
// the presence of the element, not its text, decides. Only the rows ExcelJS
// exports as data count, matched by the row number it visits.
async function countFormulaBlanks(data: ArrayBuffer, dataRowNumbers: readonly number[]): Promise<number> {
  const wanted = new Set(dataRowNumbers);
  if (wanted.size === 0) return 0;
  try {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(data);
    const workbookXml = await zip.file("xl/workbook.xml")?.async("text");
    if (!workbookXml) return 0;
    const sheetTag = /<sheet\b[^>]*>/.exec(workbookXml)?.[0];
    const sheetId = sheetTag ? attributeValue(sheetTag, "r:id") : undefined;
    if (!sheetId) return 0;
    const relsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("text");
    if (!relsXml) return 0;
    let target: string | undefined;
    for (const relationship of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
      if (attributeValue(relationship[0], "Id") !== sheetId) continue;
      target = attributeValue(relationship[0], "Target");
      break;
    }
    if (!target) return 0;
    const sheetXml = await zip.file(resolvePartPath(target))?.async("text");
    if (!sheetXml) return 0;
    let blanks = 0;
    for (const row of sheetXml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      if (!wanted.has(Number(attributeValue(row[1], "r")))) continue;
      for (const cell of (row[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const inner = cell[2] ?? "";
        if (!/<f[\s>/]/.test(inner)) continue;
        if (/<v[\s>/]/.test(inner)) continue;
        blanks += 1;
      }
    }
    return blanks;
  } catch {
    return 0;
  }
}

function attributeValue(tag: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return match ? (match[1] ?? match[2]) : undefined;
}

// Relationship targets follow package path rules. A leading slash is the
// package root; anything else is relative to the folder of xl/workbook.xml.
function resolvePartPath(target: string): string {
  const parts = target.startsWith("/") ? [] : ["xl"];
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}
