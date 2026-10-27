import type { Worksheet } from "exceljs";
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
  const data = await file.arrayBuffer();
  const loaded = await loadFirstSheet(data);
  if (!loaded) throw new Error("The first sheet of that workbook has no data rows.");
  const { sheet, bytes } = loaded;
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
  return {
    csv: toCsv(header, dataRows),
    holes,
    formulaBlanks: await countFormulaBlanks(bytes, rowNumbers.slice(1), sheet.id),
  };
}

// ExcelJS compares literal element names for the SpreadsheetML and package
// parts, so one a writer saved as <x:worksheet> parses as nothing, and a
// prefixed styles part drops the number formats, which turns a date cell into a
// serial number. These four are inflated before the load because repairing the
// whole package is only worth its cost once something is known to be wrong.
const PREFIX_CHECKED_PARTS = [
  "[Content_Types].xml",
  "xl/workbook.xml",
  "xl/_rels/workbook.xml.rels",
  "xl/styles.xml",
];

// The namespaces whose parts ExcelJS reads by literal name. A prefixed root in
// any other namespace is already read as it stands, so the docProps and theme
// parts keep their prefixes.
const LITERAL_NAMESPACES = [
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  "http://schemas.openxmlformats.org/package/2006/relationships",
  "http://schemas.openxmlformats.org/package/2006/content-types",
];

async function loadFirstSheet(data: ArrayBuffer): Promise<{ sheet: Worksheet; bytes: ArrayBuffer } | undefined> {
  const repaired = (await hasPrefixedRoot(data)) ? await repairPackage(data) : undefined;
  const first = await readSheet(repaired ?? data);
  if (first.sheet && first.sheet.rowCount >= 2) return { sheet: first.sheet, bytes: repaired ?? data };
  if (repaired) return undefined;
  const whole = await repairPackage(data);
  if (!whole) {
    if (first.error) throw first.error;
    return undefined;
  }
  const second = await readSheet(whole);
  return second.sheet && second.sheet.rowCount >= 2 ? { sheet: second.sheet, bytes: whole } : undefined;
}

async function readSheet(bytes: ArrayBuffer): Promise<{ sheet?: Worksheet; error?: unknown }> {
  try {
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    return { sheet: workbook.worksheets[0] };
  } catch (error) {
    return { error };
  }
}

async function hasPrefixedRoot(data: ArrayBuffer): Promise<boolean> {
  try {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(data);
    for (const part of PREFIX_CHECKED_PARTS) {
      const entry = zip.file(part);
      if (entry && rootTag(await entry.async("text"))?.prefix) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Returns undefined when no part carries a prefix, which is what tells the
// caller to keep a broken file's own error instead of the empty-sheet one.
async function repairPackage(data: ArrayBuffer): Promise<ArrayBuffer | undefined> {
  try {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(data);
    let changed = false;
    for (const [path, entry] of Object.entries(zip.files)) {
      if (entry.dir || !(path.endsWith(".xml") || path.endsWith(".rels"))) continue;
      const xml = await entry.async("text");
      const repaired = unprefixPart(xml);
      if (repaired === xml) continue;
      zip.file(path, repaired);
      changed = true;
    }
    return changed ? await zip.generateAsync({ type: "arraybuffer" }) : undefined;
  } catch {
    return undefined;
  }
}

// A prefixed root states its namespace as xmlns:prefix, so the part means what
// its unprefixed twin means once that one prefix comes off every element name.
// Other prefixes and all text and attribute values stay as written.
function unprefixPart(xml: string): string {
  const root = rootTag(xml);
  if (!root?.prefix) return xml;
  const declared = new RegExp(`(?:^|\\s)xmlns:${root.prefix}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(root.attributes);
  const namespace = declared?.[1] ?? declared?.[2];
  if (!namespace || !LITERAL_NAMESPACES.includes(namespace)) return xml;
  const stripped = xml.replaceAll(`</${root.prefix}:`, "</").replaceAll(`<${root.prefix}:`, "<");
  const plain = rootTag(stripped);
  if (!plain || /(?:^|\s)xmlns\s*=/.test(plain.attributes)) return stripped;
  const insertAt = plain.index + 1 + plain.name.length;
  return `${stripped.slice(0, insertAt)} xmlns="${namespace}"${stripped.slice(insertAt)}`;
}

// The part's root element, skipping the declaration and any comment. A comment
// is blanked at its own length so its index still points into the original xml.
function rootTag(xml: string): { index: number; prefix?: string; name: string; attributes: string } | undefined {
  const blanks = xml.replace(/<!--[\s\S]*?-->/g, (comment) => " ".repeat(comment.length));
  const root = /<([A-Za-z_][\w.-]*)(?::([A-Za-z_][\w.-]*))?([^>]*)>/.exec(blanks);
  if (!root) return undefined;
  return { index: root.index, prefix: root[2] ? root[1] : undefined, name: root[2] ?? root[1], attributes: root[3] };
}

// A formula cell with no `<v>` in the sheet XML has no cached result, so the
// reader loads it as blank. A cached empty string still writes `<v></v>`, so
// the presence of the element, not its text, decides. Only the rows ExcelJS
// exports as data count, matched by the row number it visits.
async function countFormulaBlanks(bytes: ArrayBuffer, dataRowNumbers: readonly number[], sheetId: number): Promise<number> {
  const wanted = new Set(dataRowNumbers);
  if (wanted.size === 0) return 0;
  try {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(bytes);
    const workbookXml = await zip.file("xl/workbook.xml")?.async("text");
    if (!workbookXml) return 0;
    const relsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("text");
    if (!relsXml) return 0;
    const partPath = sheetPartPath(workbookXml, relsXml, sheetId);
    if (!partPath) return 0;
    const sheetXml = await zip.file(partPath)?.async("text");
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

// ExcelJS drops a worksheet whose relationship target it cannot reconcile, so
// the first `<sheet>` in workbook.xml need not be the worksheet it imported.
// Its worksheet id is the numeric `sheetId` it read from the element, which is
// how the library itself links the two.
function sheetPartPath(workbookXml: string, relsXml: string, sheetId: number): string | undefined {
  const sheetTags: string[] = [];
  for (const sheet of workbookXml.matchAll(/<sheet\b[^>]*>/g)) {
    if (parseInt(attributeValue(sheet[0], "sheetId") ?? "", 10) === sheetId) sheetTags.push(sheet[0]);
  }
  if (sheetTags.length !== 1) return undefined;
  const relationshipId = attributeValue(sheetTags[0], "r:id");
  if (!relationshipId) return undefined;
  const targets: (string | undefined)[] = [];
  for (const relationship of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    if (attributeValue(relationship[0], "Id") === relationshipId) {
      targets.push(attributeValue(relationship[0], "Target"));
    }
  }
  const target = targets.length === 1 ? targets[0] : undefined;
  return target ? resolvePartPath(target) : undefined;
}

// Relationship targets follow package path rules. A leading slash is the
// package root; anything else is relative to the folder of xl/workbook.xml.
function resolvePartPath(target: string): string | undefined {
  const parts = target.startsWith("/") ? [] : ["xl"];
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.length === 0 ? undefined : parts.join("/");
}
