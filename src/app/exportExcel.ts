import {
  cumulativeColumns,
  drill,
  effectColumns,
  type BridgeConfig,
  type BridgeResult,
  type DataCheck,
  type Query,
} from "../engine.ts";
import { download } from "./files.ts";

/** Above this many configurations the detail sheet is left out and the bridge is written as values. */
const MAX_DETAIL_ROWS = 150_000;

/** 1 -> A, 27 -> AA. */
function columnLetter(index: number): string {
  let letters = "";
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

export async function exportExcel(
  query: Query,
  config: BridgeConfig,
  result: BridgeResult,
  check: DataCheck,
  description: string[],
): Promise<void> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.calcProperties.fullCalcOnLoad = true;
  const k = config.levels.length;
  const keys = cumulativeColumns(config.levels, k);
  const effects = effectColumns(config);
  const bold = { bold: true };
  const numberFormat = "#,##0;-#,##0";

  const [{ n }] = await query(`SELECT count(*)::DOUBLE AS n FROM "${result.cellsTable}"`);
  const detailRows = Number(n);
  const withDetail = detailRows <= MAX_DETAIL_ROWS;

  // Detail columns, in sheet order.
  const detail = [
    ...keys.map((key) => ({ header: key, field: key })),
    { header: "Prior units", field: "q0" },
    { header: "Prior sales with units", field: "s0" },
    { header: "Current units", field: "q1" },
    { header: "Current sales with units", field: "s1" },
    { header: "Prior sales, no units", field: "z0" },
    { header: "Current sales, no units", field: "z1" },
    { header: "Match level", field: "match_level" },
    { header: "Surviving level", field: "surviving_level" },
    { header: "Status", field: "status" },
    { header: "Ref price: overall", field: "ref_0" },
    ...config.levels.map((level, i) => ({ header: `Ref price: ${level.name}`, field: `ref_${i + 1}` })),
    ...effects.map((e) => ({ header: e.label, field: e.key })),
  ];
  const letter = (field: string) => columnLetter(detail.findIndex((d) => d.field === field) + 1);

  const bridge = workbook.addWorksheet("Bridge");
  bridge.columns = [{ width: 34 }, { width: 18 }, { width: 16 }];
  bridge.addRow([`Sales bridge: ${config.prior} to ${config.current}`]).font = bold;
  bridge.addRow([]);
  bridge.addRow(["", "Amount", "% of prior sales"]).font = bold;
  const lastDetailRow = detailRows + 1;
  const total = (field: string, value: number) =>
    withDetail ? { formula: `SUM(Detail!${letter(field)}2:${letter(field)}${lastDetailRow})`, result: value } : value;
  const sales = (a: string, b: string, value: number) =>
    withDetail
      ? { formula: `SUM(Detail!${letter(a)}2:${letter(a)}${lastDetailRow})+SUM(Detail!${letter(b)}2:${letter(b)}${lastDetailRow})`, result: value }
      : value;
  bridge.addRow(["Prior sales", sales("s0", "z0", result.priorSales)]).font = bold;
  for (const effect of effects) {
    const value = result.effects.find((e) => e.key === effect.key)!.value;
    const row = bridge.addRow([effect.label, total(effect.key, value)]);
    row.getCell(3).value = { formula: `B${row.number}/B4`, result: value / result.priorSales };
    row.getCell(3).numFmt = "0.0%";
  }
  bridge.addRow(["Current sales", sales("s1", "z1", result.currentSales)]).font = bold;
  const checkRow = bridge.addRow([
    "Check: prior + effects - current",
    { formula: `SUM(B4:B${4 + effects.length})-B${5 + effects.length}`, result: 0 },
  ]);
  checkRow.font = { italic: true };
  bridge.getColumn(2).numFmt = numberFormat;
  if (!withDetail) {
    bridge.addRow([]);
    bridge.addRow([
      `Detail sheet omitted: ${detailRows.toLocaleString("en-US")} configurations is over the ${MAX_DETAIL_ROWS.toLocaleString("en-US")} row limit, so the amounts above are values, not formulas.`,
    ]);
  }

  const coverage = workbook.addWorksheet("Match coverage");
  coverage.columns = [{ width: 44 }, { width: 14 }, { width: 18 }, { width: 16 }];
  coverage.addRow(["Compared against", "Share", "Current sales", "Configurations"]).font = bold;
  for (const c of result.coverage) coverage.addRow([c.label, c.share, c.sales, c.cells]);
  coverage.getColumn(2).numFmt = "0.0%";
  coverage.getColumn(3).numFmt = numberFormat;

  for (const level of config.levels) {
    const rows = await drill(query, config, { columns: level.columns, limit: 5000 });
    const sheet = workbook.addWorksheet(`By ${level.name}`.replace(/[\\/*?:[\]]/g, " ").slice(0, 31));
    sheet.addRow([...level.columns, "Prior sales", "Current sales", "Change", ...effects.map((e) => e.label)]).font = bold;
    for (const row of rows) {
      sheet.addRow([
        ...level.columns.map((c) => (row[c] === null ? "(blank)" : String(row[c]))),
        Number(row.s0) + Number(row.z0),
        Number(row.s1) + Number(row.z1),
        Number(row.s1) + Number(row.z1) - Number(row.s0) - Number(row.z0),
        ...effects.map((e) => Number(row[e.key])),
      ]);
    }
    sheet.columns.forEach((column, index) => {
      column.width = 16;
      if (index >= level.columns.length) column.numFmt = numberFormat;
    });
  }

  if (withDetail) {
    const sheet = workbook.addWorksheet("Detail");
    sheet.addRow(detail.map((d) => d.header)).font = bold;
    const rows = await query(
      `SELECT * FROM "${result.cellsTable}" ORDER BY abs(s1 + z1 - s0 - z0) DESC`,
    );
    const delta = `(${letter("q1")}#-${letter("q0")}#)`;
    const rest = `${letter("s1")}#-${letter("s0")}#-${delta}*${letter(`ref_${k}`)}#`;
    const change = `${letter("s1")}#-${letter("s0")}#`;
    const status = (value: string) => `${letter("status")}#="${value}"`;
    const full = config.newAndDiscontinued === "full";
    const formulas: Record<string, string> = full
      ? {
          volume: `IF(${status("continuing")},${delta}*${letter("ref_0")}#,0)`,
          price: `IF(${status("continuing")},${rest},0)`,
          new_config: `IF(${status("new")},${change},0)`,
          discontinued: `IF(${status("discontinued")},${change},0)`,
        }
      : {
          volume: `${delta}*${letter("ref_0")}#`,
          price: `IF(${letter("match_level")}#=${k},${rest},0)`,
          new_config: `IF(${letter("match_level")}#<${k},${rest},0)`,
          discontinued: `${delta}*(${letter(`ref_${k}`)}#-CHOOSE(${letter("surviving_level")}#+1,${Array.from({ length: k + 1 }, (_, j) => `${letter(`ref_${j}`)}#`).join(",")}))`,
        };
    formulas.no_units = `${letter("z1")}#-${letter("z0")}#`;
    for (let j = 1; j <= k; j++) {
      const mix = `${delta}*(${letter(`ref_${j}`)}#-${letter(`ref_${j - 1}`)}#)`;
      formulas[`mix_${j}`] = `IF(${full ? status("continuing") : `${letter("surviving_level")}#>=${j}`},${mix},0)`;
    }
    rows.forEach((row, index) => {
      const r = String(index + 2);
      sheet.addRow(
        detail.map((d) => {
          const value = row[d.field];
          if (formulas[d.field]) return { formula: formulas[d.field].replaceAll("#", r), result: Number(value) };
          if (keys.includes(d.field) || d.field === "status") return value === null ? "" : String(value);
          if (value === null) return "";
          return Number(value);
        }),
      );
    });
    sheet.columns.forEach((column) => (column.width = 16));
    sheet.views = [{ state: "frozen", ySplit: 1 }];
  }

  const setup = workbook.addWorksheet("Setup");
  setup.columns = [{ width: 34 }, { width: 60 }];
  for (const line of description) setup.addRow(line.split(": ", 2));
  setup.addRow([]);
  setup.addRow(["Rows read", check.rows]);
  setup.addRow([`Rows in ${config.prior}`, check.priorRows]);
  setup.addRow([`Rows in ${config.current}`, check.currentRows]);
  setup.addRow(["Rows in other periods (ignored)", check.otherPeriodRows]);
  setup.addRow(["Rows with blank units or sales", check.blankMeasureRows]);
  setup.addRow(["Rows with negative units", check.negativeUnitRows]);

  const buffer = await workbook.xlsx.writeBuffer();
  download(
    `bridge-${config.prior}-to-${config.current}.xlsx`,
    buffer,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
}
