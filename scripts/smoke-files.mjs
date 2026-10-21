import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const FIXTURE_HEADER = ["sale_date", "customer", "design", "units", "net_sales"];
export const FIXTURE_LEVELS = [
  { name: "Design", columns: ["design"] },
  { name: "Customer", columns: ["customer"] },
];

export function fixtureRows() {
  const rows = [];
  for (let k = 0; k < 120; k++) {
    const month = String((k % 12) + 1).padStart(2, "0");
    const day = String((k % 28) + 1).padStart(2, "0");
    const customer = `C${k % 5}`;
    const design = `D${k % 4}`;
    const units = 1 + (k % 3);
    const base = 100 + (k % 7) * 10;
    for (const year of [2024, 2025]) {
      const price = base + (year === 2025 ? 5 : 0);
      rows.push([`${year}-${month}-${day}`, customer, design, units, units * price]);
    }
  }
  return rows;
}

const csvCell = (value) => {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export const toCsvText = (header, rows) =>
  [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";

export const toTsvText = (header, rows) =>
  [header, ...rows].map((row) => row.join("\t")).join("\n") + "\n";

export const FORMATTED_HEADER = ["period", "product", "units", "sales"];
export const FORMATTED_ROWS = [
  ["2024", "A", 10, "1,234.50"],
  ["2024", "B", 5, "$2,000.50"],
  ["2024", "A", 2, "(100)"],
  ["2025", "A", 10, "3,000.00"],
  ["2025", "B", 5, "$1,500.00"],
  ["2025", "B", 1, "(50)"],
];
export const FORMATTED_PRIOR = 3135;
export const FORMATTED_CURRENT = 4450;
export const FORMATTED_TOTAL = 7585;

export async function writeFixtures(dir) {
  const rows = fixtureRows();
  const csvPath = join(dir, "smoke.csv");
  writeFileSync(csvPath, toCsvText(FIXTURE_HEADER, rows));
  const formattedPath = join(dir, "smoke-formatted.csv");
  writeFileSync(formattedPath, toCsvText(FORMATTED_HEADER, FORMATTED_ROWS));

  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("sales");
  sheet.addRow(FIXTURE_HEADER);
  for (const row of rows) sheet.addRow(row);
  const xlsxPath = join(dir, "smoke.xlsx");
  await workbook.xlsx.writeFile(xlsxPath);

  return { rows, csvPath, xlsxPath, formattedPath };
}
