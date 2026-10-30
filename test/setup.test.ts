import assert from "node:assert/strict";
import { test } from "node:test";
import {
  affectsRemember,
  calculateGate,
  cleanLevels,
  effectiveName,
  ENGINE_LOADING_TEXT,
  guessSetup,
  measureNote,
  refineGuess,
  initialPhase,
  isDate,
  isNumeric,
  isRemembering,
  isValidSetup,
  loadSavedSetup,
  mainView,
  MAX_LEVEL_NAME,
  measureChange,
  netSalesHeldAsText,
  nextPhase,
  PERIOD,
  rememberFrom,
  saveSetup,
  setRemembering,
  shouldAutoRun,
  shouldWarn,
  TABLE,
  VIEW,
  viewSql,
  type Column,
  type EngineState,
  type Phase,
  type Setup,
} from "../src/app/setup.ts";
import { openDatabase } from "../src/duckdb.ts";

function legacyGuess(columns: Column[]): Setup {
  const find = (pattern: RegExp, among: Column[]) => among.find((c) => pattern.test(c.name))?.name ?? "";
  const numeric = columns.filter((c) => isNumeric(c.type));
  const date = columns.find((c) => isDate(c.type));
  const salesColumn = find(/net/i, numeric) || find(/sales|revenue|amount|value/i, numeric);
  const grossColumn = find(/gross|list/i, numeric);
  return {
    periodColumn: date?.name ?? find(/year|period|month|quarter|date/i, columns),
    grain: date ? "year" : "value",
    unitsColumn: find(/unit|qty|quant|jobs|volume|pieces/i, numeric),
    salesColumn,
    grossColumn: grossColumn && grossColumn !== salesColumn ? grossColumn : undefined,
    levels: [],
    filters: [],
  };
}

const unitWords = ["unit", "units"];
const priceWords = ["price", "cost", "rate"];
const perWord = "per";
const noteWords = ["note", "notes", "comment", "comments"];

function headerWords(name: string): string[] {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part !== "")
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .map((word) => word.toLowerCase());
}

function pairsUnitPrice(name: string): boolean {
  const parts = headerWords(name);
  const across = (left: string, right: string) =>
    (unitWords.includes(left) && priceWords.includes(right)) || (priceWords.includes(left) && unitWords.includes(right));
  for (let i = 0; i < parts.length - 1; i++) {
    if (across(parts[i], parts[i + 1])) return true;
    if (parts[i + 1] === perWord && across(parts[i], parts[i + 2] ?? "")) return true;
  }
  return false;
}

function trailingNote(name: string): boolean {
  return noteWords.includes(headerWords(name).at(-1) ?? "");
}

function measures(name: string, type = "DOUBLE"): Setup {
  return guessSetup([{ name, type }]);
}

const moneyWord = (name: string) =>
  /sales|revenue|amount|value|turnover|total|umsatz|erlos|betrag|montant|ventes|vente|recette|valeur|affaires|ventas|importe|ingresos|valor|omzet|bedrag|verkoop|waarde/i.test(
    name,
  );
const countWord = (name: string) => /unit|qty|quant|count|job|piece|menge|anzahl|absatz|stueck|stuck|boite|bottl/i.test(name);

test("audit columns guess units and sales", () => {
  const setup = guessSetup([
    { name: "year", type: "BIGINT" },
    { name: "product", type: "VARCHAR" },
    { name: "unit_price", type: "BIGINT" },
    { name: "units", type: "BIGINT" },
    { name: "net_units_note", type: "BIGINT" },
    { name: "sales", type: "BIGINT" },
  ]);
  assert.equal(setup.unitsColumn, "units");
  assert.equal(setup.salesColumn, "sales");
  assert.equal(setup.periodColumn, "year");
  assert.equal(setup.grain, "value");
  assert.equal(setup.grossColumn, undefined);
  assert.equal(setup.costColumn, undefined);
  assert.deepEqual(setup.levels, []);
  assert.deepEqual(setup.filters, []);
});

test("unit_price and net_units_note leave units and sales empty", () => {
  const setup = guessSetup([
    { name: "unit_price", type: "BIGINT" },
    { name: "net_units_note", type: "BIGINT" },
  ]);
  assert.equal(setup.unitsColumn, "");
  assert.equal(setup.salesColumn, "");
});

test("excluded unit price column unitPrice", () => {
  const setup = measures("unitPrice");
  assert.equal(setup.unitsColumn, "");
  assert.equal(setup.salesColumn, "");
  assert.equal(setup.grossColumn, undefined);
});

test("excluded unit price column UNIT_PRICE", () => {
  const setup = measures("UNIT_PRICE");
  assert.equal(setup.unitsColumn, "");
  assert.equal(setup.salesColumn, "");
  assert.equal(setup.grossColumn, undefined);
});

test("excluded price per unit column Price per Unit", () => {
  const setup = measures("Price per Unit");
  assert.equal(setup.unitsColumn, "");
  assert.equal(setup.salesColumn, "");
  assert.equal(setup.grossColumn, undefined);
});

test("excluded unit cost column Unit Cost", () => {
  const setup = measures("Unit Cost");
  assert.equal(setup.unitsColumn, "");
  assert.equal(setup.salesColumn, "");
  assert.equal(setup.grossColumn, undefined);
});

test("excluded unit rate column unit rate", () => {
  const setup = measures("unit rate");
  assert.equal(setup.unitsColumn, "");
  assert.equal(setup.salesColumn, "");
  assert.equal(setup.grossColumn, undefined);
});

test("excluded unit rate column unitRate", () => {
  const setup = measures("unitRate");
  assert.equal(setup.unitsColumn, "");
  assert.equal(setup.salesColumn, "");
  assert.equal(setup.grossColumn, undefined);
});

test("excluded cost per unit column cost_per_unit", () => {
  const setup = measures("cost_per_unit");
  assert.equal(setup.unitsColumn, "");
  assert.equal(setup.salesColumn, "");
  assert.equal(setup.grossColumn, undefined);
});

test("excluded price unit column price_unit", () => {
  const setup = measures("price_unit");
  assert.equal(setup.unitsColumn, "");
  assert.equal(setup.salesColumn, "");
  assert.equal(setup.grossColumn, undefined);
});

test("excluded units price column units_price", () => {
  const setup = measures("units_price");
  assert.equal(setup.unitsColumn, "");
  assert.equal(setup.salesColumn, "");
  assert.equal(setup.grossColumn, undefined);
});

test("excluded note column net_units_note", () => {
  const setup = measures("net_units_note");
  assert.equal(setup.unitsColumn, "");
  assert.equal(setup.salesColumn, "");
  assert.equal(setup.grossColumn, undefined);
});

test("excluded comment column Sales Comment", () => {
  const setup = measures("Sales Comment");
  assert.equal(setup.unitsColumn, "");
  assert.equal(setup.salesColumn, "");
  assert.equal(setup.grossColumn, undefined);
});

test("excluded notes column sales_notes", () => {
  const setup = measures("sales_notes");
  assert.equal(setup.unitsColumn, "");
  assert.equal(setup.salesColumn, "");
  assert.equal(setup.grossColumn, undefined);
});

test("excluded comments column units comments", () => {
  const setup = measures("units comments");
  assert.equal(setup.unitsColumn, "");
  assert.equal(setup.salesColumn, "");
  assert.equal(setup.grossColumn, undefined);
});

test("kept Units Sold at Full Price", () => {
  const setup = measures("Units Sold at Full Price");
  assert.equal(setup.unitsColumn, "Units Sold at Full Price");
  assert.equal(setup.salesColumn, "");
  assert.equal(setup.grossColumn, undefined);
});

test("kept Net Extended Price", () => {
  const setup = measures("Net Extended Price");
  assert.equal(setup.unitsColumn, "");
  assert.equal(setup.salesColumn, "Net Extended Price");
  assert.equal(setup.grossColumn, undefined);
});

test("kept Gross Extended Price", () => {
  const setup = measures("Gross Extended Price");
  assert.equal(setup.unitsColumn, "");
  assert.equal(setup.salesColumn, "");
  assert.equal(setup.grossColumn, "Gross Extended Price");
});

test("kept Rate Card Sales", () => {
  const setup = measures("Rate Card Sales");
  assert.equal(setup.unitsColumn, "");
  assert.equal(setup.salesColumn, "Rate Card Sales");
  assert.equal(setup.grossColumn, undefined);
});

test("kept Business Unit Sales", () => {
  const setup = measures("Business Unit Sales");
  assert.equal(setup.unitsColumn, "Business Unit Sales");
  assert.equal(setup.salesColumn, "");
  assert.equal(setup.grossColumn, undefined);
});

test("kept Sales Volume (USD)", () => {
  const setup = measures("Sales Volume (USD)");
  assert.equal(setup.unitsColumn, "");
  assert.equal(setup.salesColumn, "Sales Volume (USD)");
  assert.equal(setup.grossColumn, undefined);
});

test("kept Units Sold by Product Code", () => {
  const setup = measures("Units Sold by Product Code");
  assert.equal(setup.unitsColumn, "Units Sold by Product Code");
  assert.equal(setup.salesColumn, "");
  assert.equal(setup.grossColumn, undefined);
});

test("kept Notebook Sales", () => {
  const setup = measures("Notebook Sales");
  assert.equal(setup.unitsColumn, "");
  assert.equal(setup.salesColumn, "Notebook Sales");
  assert.equal(setup.grossColumn, undefined);
});

test("kept unit", () => {
  const setup = measures("unit");
  assert.equal(setup.unitsColumn, "unit");
  assert.equal(setup.salesColumn, "");
  assert.equal(setup.grossColumn, undefined);
});

test("kept price", () => {
  const setup = measures("price");
  assert.equal(setup.unitsColumn, "");
  assert.equal(setup.salesColumn, "");
  assert.equal(setup.grossColumn, undefined);
});

test("kept unitprice", () => {
  const setup = measures("unitprice");
  assert.equal(setup.unitsColumn, "unitprice");
  assert.equal(setup.salesColumn, "");
  assert.equal(setup.grossColumn, undefined);
});

test("kept community", () => {
  const setup = measures("community");
  assert.equal(setup.unitsColumn, "community");
  assert.equal(setup.salesColumn, "");
  assert.equal(setup.grossColumn, undefined);
});

test("pattern unit selects unit", () => {
  assert.equal(measures("unit").unitsColumn, "unit");
});

test("pattern qty selects qty", () => {
  assert.equal(measures("qty").unitsColumn, "qty");
});

test("pattern quant selects quantity", () => {
  assert.equal(measures("quantity").unitsColumn, "quantity");
});

test("pattern jobs selects jobs", () => {
  assert.equal(measures("jobs").unitsColumn, "jobs");
});

test("pattern volume selects volume", () => {
  assert.equal(measures("volume").unitsColumn, "volume");
});

test("pattern pieces selects pieces", () => {
  assert.equal(measures("pieces").unitsColumn, "pieces");
});

test("pattern net before sales selects net", () => {
  const setup = guessSetup([
    { name: "sales", type: "DOUBLE" },
    { name: "net", type: "DOUBLE" },
  ]);
  assert.equal(setup.salesColumn, "net");
});

test("pattern sales selects sales", () => {
  assert.equal(measures("sales").salesColumn, "sales");
});

test("pattern revenue selects revenue", () => {
  assert.equal(measures("revenue").salesColumn, "revenue");
});

test("pattern amount selects amount", () => {
  assert.equal(measures("amount").salesColumn, "amount");
});

test("pattern value selects value", () => {
  assert.equal(measures("value").salesColumn, "value");
});

test("German Menge guesses units", () => {
  assert.equal(measures("Menge", "DOUBLE").unitsColumn, "Menge");
});

test("German Stueck, Anzahl and Absatz guess units", () => {
  for (const name of ["Stück", "Stueck", "Anzahl", "Absatz"]) {
    assert.equal(measures(name, "DOUBLE").unitsColumn, name, name);
  }
});

test("German Umsatz and Erloese guess sales", () => {
  assert.equal(measures("Umsatz", "DOUBLE").salesColumn, "Umsatz");
  assert.equal(measures("Erlöse", "DOUBLE").salesColumn, "Erlöse");
});

test("German Stueckpreis and Kosten compounds leave units empty", () => {
  for (const name of ["Stückpreis", "Stueckpreis", "Stückkosten", "Mengenpreis"]) {
    const setup = measures(name, "DOUBLE");
    assert.equal(setup.unitsColumn, "", name);
    assert.equal(setup.salesColumn, "", name);
  }
});

test("German Umsatzsteuer is a tax and guesses no sales", () => {
  assert.equal(measures("Umsatzsteuer", "DOUBLE").salesColumn, "");
});

test("pin: Invoiced Amount guesses sales", () => {
  assert.equal(measures("Invoiced Amount", "DOUBLE").salesColumn, "Invoiced Amount");
});

test("pin: Total Quantity guesses units", () => {
  assert.equal(measures("Total Quantity", "DOUBLE").unitsColumn, "Total Quantity");
});

test("pin: Turnover is read as sales", () => {
  const setup = measures("Turnover", "DOUBLE");
  assert.equal(setup.salesColumn, "Turnover");
  assert.equal(setup.unitsColumn, "");
});

test("pattern gross selects gross", () => {
  const setup = guessSetup([
    { name: "sales", type: "DOUBLE" },
    { name: "gross", type: "DOUBLE" },
  ]);
  assert.equal(setup.grossColumn, "gross");
});

test("pattern list selects list_price", () => {
  const setup = guessSetup([
    { name: "sales", type: "DOUBLE" },
    { name: "list_price", type: "DOUBLE" },
  ]);
  assert.equal(setup.grossColumn, "list_price");
});

test("pattern year is the period", () => {
  const setup = measures("year", "VARCHAR");
  assert.equal(setup.periodColumn, "year");
  assert.equal(setup.grain, "value");
});

test("pattern period is the period", () => {
  const setup = measures("period", "VARCHAR");
  assert.equal(setup.periodColumn, "period");
  assert.equal(setup.grain, "value");
});

test("pattern month is the period", () => {
  const setup = measures("month", "VARCHAR");
  assert.equal(setup.periodColumn, "month");
  assert.equal(setup.grain, "value");
});

test("pattern quarter is the period", () => {
  const setup = measures("quarter", "VARCHAR");
  assert.equal(setup.periodColumn, "quarter");
  assert.equal(setup.grain, "value");
});

test("pattern date is the period", () => {
  const setup = measures("date", "VARCHAR");
  assert.equal(setup.periodColumn, "date");
  assert.equal(setup.grain, "value");
});

test("pattern INT selects INTEGER units", () => {
  assert.equal(measures("units", "INTEGER").unitsColumn, "units");
});

test("pattern DOUBLE selects DOUBLE units", () => {
  assert.equal(measures("units", "DOUBLE").unitsColumn, "units");
});

test("pattern DECIMAL selects DECIMAL units", () => {
  assert.equal(measures("units", "DECIMAL").unitsColumn, "units");
});

test("pattern FLOAT selects FLOAT units", () => {
  assert.equal(measures("units", "FLOAT").unitsColumn, "units");
});

test("pattern REAL selects REAL units", () => {
  assert.equal(measures("units", "REAL").unitsColumn, "units");
});

test("pattern VARCHAR units stays unset", () => {
  assert.equal(measures("units", "VARCHAR").unitsColumn, "");
});

test("pattern DATE column posted is the period", () => {
  const setup = measures("posted", "DATE");
  assert.equal(setup.periodColumn, "posted");
  assert.equal(setup.grain, "year");
});

test("pattern TIMESTAMP column posted_at is the period", () => {
  const setup = measures("posted_at", "TIMESTAMP");
  assert.equal(setup.periodColumn, "posted_at");
  assert.equal(setup.grain, "year");
});

const textNames = new Set(["year", "product", "Year", "Product", "Jahr", "Produkt", "año", "producto"]);

const headers: { names: string[]; textMeasures: boolean }[] = [
  {
    "names": [
      "year",
      "product",
      "unit_price",
      "units",
      "net_units_note",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "Net Sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "Sales Amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "Total Sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "Revenue (USD)"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "Net Revenue"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "net_amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "net"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "sales_amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "NetSales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "total_revenue"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "Qty Sold",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "Units Sold",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "Quantity Shipped",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "Sales Qty",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "Sales Units",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "Volume (kg)",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "order_quantity",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "total_units",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "UnitsSold",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "Year",
      "Product",
      "uNiTs",
      "nEt SaLeS"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units ",
      "sales "
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      " Units",
      " Revenue"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "Jahr",
      "Produkt",
      "Menge",
      "Nettoumsatz"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "año",
      "producto",
      "unidades",
      "ventas"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "Qty Sold",
      "unit",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "Net Revenue",
      "amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "Net Sales",
      "Gross Sales Amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "qty",
      "units",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "revenue",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "unit_price",
      "price_per_unit",
      "unit cost",
      "net_units_note"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "sales"
    ],
    "textMeasures": true
  },
  {
    "names": [
      "year",
      "product",
      "unit_price",
      "units",
      "net_units_note",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "Net Sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "Sales Amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "Total Sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "Revenue (USD)"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "Net Revenue"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "net_amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "net"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "sales_amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "NetSales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "total_revenue"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "Qty Sold",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "Units Sold",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "Quantity Shipped",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "Sales Qty",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "Sales Units",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "Volume (kg)",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "order_quantity",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "total_units",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "UnitsSold",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "Year",
      "Product",
      "uNiTs",
      "nEt SaLeS"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units ",
      "sales "
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      " Units",
      " Revenue"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "Jahr",
      "Produkt",
      "Menge",
      "Nettoumsatz"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "año",
      "producto",
      "unidades",
      "ventas"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "Qty Sold",
      "unit",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "Net Revenue",
      "amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "Net Sales",
      "Gross Sales Amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "qty",
      "units",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "revenue",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "unit_price",
      "price_per_unit",
      "unit cost",
      "net_units_note"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "sales"
    ],
    "textMeasures": true
  },
  {
    "names": [
      "gross_sales",
      "list_sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "Gross Sales Amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "Net Sales (USD)"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "NetSales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "UnitsSold",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "unitPrice",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "sales",
      "SalesQty"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "sales",
      "ID"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "Sales (EUR)"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "Sales [k€]"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "Volume (units)",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "Price (USD)"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "Qty",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "QTY.",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "Rev"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "Net Rev"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "Sales $"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "Sales_USD"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "Total Revenue"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "Turnover"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "Invoiced Amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "Sales",
      "Net Sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "Sales 2025",
      "Sales 2026"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "Sales",
      "Sales Qty"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "Menge",
      "Umsatz"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "Cantidad",
      "Ventas"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "Quantity Sold",
      "unit",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "Volume (units)",
      "unit",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "Net Rev",
      "amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "Sales [k€]",
      "amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "Quantities Sold",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "Quantity Sold",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "Units Shipped",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "Total Quantity",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "Sales USD"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "Sales (units)"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "NetSalesQty"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "Net Sales",
      "Net Revenue"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "Units Sold",
      "Qty Sold",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "sales",
      "SalesID",
      "unitID"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "Net Sales",
      "Gross Sales Amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "unit_price",
      "net_units_note"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "Units Sold (USD)",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "Net Sales (kg)"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "sales",
      "list_price"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "Gross Sales Amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "Gross Sales Amount",
      "amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "List Sales Amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "List Sales Amount",
      "amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "gross_sales",
      "amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "units",
      "list_sales",
      "amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "Net Extended Price",
      "amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "sales",
      "Gross Extended Price"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "Rate Card Sales",
      "amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "Units Sold at Full Price",
      "unit",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "Units Sold at Cost",
      "unit",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "Units Sold by Customer ID",
      "unit",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "Units Sold by Product Code",
      "unit",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "Business Unit Sales",
      "amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "Sales Volume (USD)",
      "amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "Sales (Currency Units)",
      "amount"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "unit_price",
      "units",
      "net_units_note",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "Sales Qty",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "Sales Units",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "unit_price",
      "price_per_unit",
      "unit cost",
      "net_units_note"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "unitPrice",
      "sales"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "Sales (units)"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "NetSalesQty"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "unit_price",
      "net_units_note"
    ],
    "textMeasures": false
  },
  {
    "names": [
      "year",
      "product",
      "units",
      "sales",
      "list_price"
    ],
    "textMeasures": false
  }
];

// The four families the legacy oracle cannot judge, pinned here from the fixed
// guess so no header row escapes this test. Keys are the header rows joined
// with ", ", which repeats a row that appears twice in the matrix.
const pinned = new Map<string, { period: string; units: string; sales: string }>([
  // German: the oracle knows no German stems, unit prices or tax columns.
  ["Jahr, Produkt, Menge, Nettoumsatz", { period: "Jahr", units: "Menge", sales: "Nettoumsatz" }],
  ["Menge, Umsatz", { period: "", units: "Menge", sales: "Umsatz" }],
  // The wider money words, in French, Spanish and Dutch or the English turnover.
  ["año, producto, unidades, ventas", { period: "año", units: "", sales: "ventas" }],
  ["Cantidad, Ventas", { period: "", units: "", sales: "Ventas" }],
  ["units, Turnover", { period: "", units: "units", sales: "Turnover" }],
  // A name that says both money and a count, such as "Sales Qty", is a count now.
  ["year, product, Sales Qty, sales", { period: "year", units: "Sales Qty", sales: "sales" }],
  ["year, product, Sales Units, sales", { period: "year", units: "Sales Units", sales: "sales" }],
  ["year, product, total_units, sales", { period: "year", units: "total_units", sales: "sales" }],
  ["sales, SalesQty", { period: "", units: "SalesQty", sales: "sales" }],
  ["units, Sales, Sales Qty", { period: "", units: "units", sales: "Sales" }],
  ["Total Quantity, sales", { period: "", units: "Total Quantity", sales: "sales" }],
  ["units, Sales (units)", { period: "", units: "units", sales: "" }],
  ["units, NetSalesQty", { period: "", units: "units", sales: "NetSalesQty" }],
  ["year, product, units, Business Unit Sales, amount", { period: "year", units: "units", sales: "amount" }],
  [
    "year, product, units, Sales (Currency Units), amount",
    { period: "year", units: "units", sales: "Sales (Currency Units)" },
  ],
  ["year, product, units, Sales (units)", { period: "year", units: "units", sales: "" }],
  ["year, product, units, NetSalesQty", { period: "year", units: "units", sales: "NetSalesQty" }],
  // A count name beats one that also names a size, such as "Volume (units)".
  ["Volume (units), sales", { period: "", units: "Volume (units)", sales: "sales" }],
  ["Volume (units), unit, sales", { period: "", units: "unit", sales: "sales" }],
]);

/** The four families the legacy oracle cannot judge, kept in one place. */
const outsideLegacy = (names: string[]) =>
  names.some((name) => /jahr|menge|umsatz|nettoumsatz|stueck|steuer|erl[öo]s/i.test(name)) ||
  names.some((name) =>
    /montant|ventes|vente|recette|valeur|affaires|ventas|importe|ingresos|valor|omzet|bedrag|verkoop|waarde|turnover/i.test(
      name,
    ),
  ) ||
  names.some((name) => moneyWord(name) && countWord(name)) ||
  names.some((name) => countWord(name) && /volume|size|ml|litre|liter|kg|weight|gram|amount/i.test(name));

test("oracle headers match the legacy guess outside excluded words", () => {
  for (const row of headers) {
    const columns: Column[] = row.names.map((name) => ({
      name,
      type: row.textMeasures || textNames.has(name) ? "VARCHAR" : "DOUBLE",
    }));
    const message = row.names.join(", ");
    const actual = guessSetup(columns);
    if (outsideLegacy(row.names)) {
      const expected = pinned.get(message);
      assert.ok(expected !== undefined, `no pin for the skipped row: ${message}`);
      assert.deepEqual(
        { period: actual.periodColumn, units: actual.unitsColumn, sales: actual.salesColumn },
        expected,
        message,
      );
      continue;
    }
    const legacy = legacyGuess(columns);
    assert.equal(actual.periodColumn, legacy.periodColumn, message);
    assert.equal(actual.grain, legacy.grain, message);
    assert.equal(actual.costColumn, legacy.costColumn, message);
    assert.deepEqual(actual.levels, legacy.levels, message);
    assert.deepEqual(actual.filters, legacy.filters, message);
    const unitsGuess = legacyGuess(columns.filter((column) => !pairsUnitPrice(column.name) && !trailingNote(column.name)));
    const salesGuess = legacyGuess(columns.filter((column) => !trailingNote(column.name)));
    assert.equal(actual.unitsColumn, unitsGuess.unitsColumn, message);
    assert.equal(actual.salesColumn, salesGuess.salesColumn, message);
    assert.equal(actual.grossColumn, salesGuess.grossColumn, message);
  }
  // Neither side of the table can drift: every pin belongs to a skipped row and
  // every skipped row has a pin.
  const skipped = new Set(headers.filter((row) => outsideLegacy(row.names)).map((row) => row.names.join(", ")));
  for (const key of pinned.keys()) assert.ok(skipped.has(key), `pinned row is not skipped: ${key}`);
  for (const key of skipped) assert.ok(pinned.has(key), `skipped row has no pin: ${key}`);
});

// The remembered and loaded paths read localStorage at call time, so a stub
// replaces it for this file only. Its stored keys enumerate the way a real
// Storage does, because the opt-out path walks Object.keys(localStorage).
const stored = new Map<string, string>();
const storageMethods = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, value),
  removeItem: (key: string) => void stored.delete(key),
  key: (index: number) => [...stored.keys()][index] ?? null,
  get length() {
    return stored.size;
  },
  clear: () => stored.clear(),
};
const localStorageStub = new Proxy(storageMethods, {
  get: (target, key) => (typeof key === "string" && !(key in target) ? stored.get(key) : Reflect.get(target, key)),
  ownKeys: (target) => [...new Set([...Reflect.ownKeys(target), ...stored.keys()])],
  getOwnPropertyDescriptor: (target, key) =>
    typeof key === "string" && stored.has(key)
      ? { value: stored.get(key), enumerable: true, configurable: true, writable: true }
      : Reflect.getOwnPropertyDescriptor(target, key),
});
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: localStorageStub,
});

const salesTable: Column[] = [
  { name: "year", type: "BIGINT" },
  { name: "product", type: "VARCHAR" },
  { name: "units", type: "BIGINT" },
  { name: "sales", type: "DOUBLE" },
];
const withType = (columns: Column[], name: string, type: string): Column[] =>
  columns.map((column) => (column.name === name ? { ...column, type } : column));

const workedSetup: Setup = {
  periodColumn: "year",
  grain: "value",
  unitsColumn: "units",
  salesColumn: "sales",
  levels: [{ name: "Product", columns: ["product"] }],
  filters: [],
};

test("a remembered setup is dropped when a same-named table's sales column is text", () => {
  stored.clear();
  setRemembering(true);
  saveSetup(salesTable, workedSetup);
  assert.deepEqual(loadSavedSetup(salesTable), workedSetup);
  assert.equal(loadSavedSetup(withType(salesTable, "sales", "VARCHAR")), null);
});

test("a remembered setup is dropped when its date grain meets a BIGINT period column", () => {
  stored.clear();
  setRemembering(true);
  const dated: Column[] = withType(salesTable, "year", "DATE");
  const yearly: Setup = { ...workedSetup, grain: "year" };
  saveSetup(dated, yearly);
  assert.deepEqual(loadSavedSetup(dated), yearly);
  assert.equal(loadSavedSetup(salesTable), null);
});

test("a fresh visitor stores nothing until Remember is ticked", () => {
  stored.clear();
  assert.equal(isRemembering(), false);
  saveSetup(salesTable, workedSetup);
  assert.equal(stored.size, 0);
});

test("ticking Remember writes on and keeps a setup another tab saved", () => {
  stored.clear();
  stored.set("bridgekit:remember", "on");
  saveSetup(salesTable, workedSetup);
  stored.set("bridgekit:remember", "off");
  setRemembering(true);
  assert.equal(stored.get("bridgekit:remember"), "on");
  assert.equal(stored.size, 2);
  assert.equal(isRemembering(), true);
});

test("unticking Remember leaves no stored key at all", () => {
  stored.clear();
  setRemembering(true);
  saveSetup(salesTable, workedSetup);
  stored.set("other-site-key", "kept");
  setRemembering(false);
  assert.deepEqual([...stored.keys()], ["other-site-key"]);
  assert.equal(isRemembering(), false);
});

test("a visitor with setups saved before the opt-in still remembers", () => {
  stored.clear();
  stored.set(`bridgekit:setup:${["product", "sales", "units", "year"].join("|")}`, JSON.stringify(workedSetup));
  assert.equal(isRemembering(), true);
  assert.deepEqual(loadSavedSetup(salesTable), workedSetup);
});

test("the remember choice reads on, off, and legacy storage", () => {
  const setupKey = "bridgekit:setup:a|b";
  const cases: [string | null, string[], boolean][] = [
    ["on", [], true],
    ["on", ["bridgekit:remember"], true],
    ["off", [], false],
    ["off", [setupKey], false],
    [null, [], false],
    [null, ["other"], false],
    [null, [setupKey], true],
    ["yes", [setupKey], false],
    ["", [], false],
  ];
  for (const [value, keys, expected] of cases) {
    assert.equal(rememberFrom(value, keys), expected, `${value} with ${keys.join(",")}`);
  }
});

test("only a clear, the remember key or a setup key changes the remember choice", () => {
  assert.equal(affectsRemember(null), true);
  assert.equal(affectsRemember("bridgekit:remember"), true);
  assert.equal(affectsRemember("bridgekit:setup:a|b"), true);
  assert.equal(affectsRemember("bridgekit:other"), false);
  assert.equal(affectsRemember("other"), false);
});

test("a remembered attribute name is cut to the editor limit", () => {
  stored.clear();
  setRemembering(true);
  const long: Setup = { ...workedSetup, levels: [{ name: "N".repeat(5000), columns: ["product"] }] };
  saveSetup(salesTable, long);
  assert.equal(loadSavedSetup(salesTable)?.levels[0].name, "N".repeat(MAX_LEVEL_NAME));
  assert.equal(MAX_LEVEL_NAME, 60);
});

test("a loaded setup that names a text column as sales is refused", () => {
  assert.equal(isValidSetup(workedSetup, salesTable), true);
  assert.equal(isValidSetup(workedSetup, withType(salesTable, "sales", "VARCHAR")), false);
});

test("a loaded setup that names a text column as units, gross or cost is refused", () => {
  const loading: Setup = { ...workedSetup, unitsColumn: "units" };
  assert.equal(isValidSetup(loading, salesTable), true);
  assert.equal(isValidSetup(loading, withType(salesTable, "units", "VARCHAR")), false);
  const gross: Setup = { ...workedSetup, grossColumn: "gross" };
  assert.equal(isValidSetup(gross, [...salesTable, { name: "gross", type: "DOUBLE" }]), true);
  assert.equal(isValidSetup(gross, [...salesTable, { name: "gross", type: "VARCHAR" }]), false);
  const margin: Setup = { ...workedSetup, costColumn: "cost" };
  assert.equal(isValidSetup(margin, [...salesTable, { name: "cost", type: "DOUBLE" }]), true);
  assert.equal(isValidSetup(margin, [...salesTable, { name: "cost", type: "VARCHAR" }]), false);
});

test("a loaded setup whose date grain meets a non-date period column is refused", () => {
  const yearly: Setup = { ...workedSetup, grain: "year" };
  assert.equal(isValidSetup(yearly, withType(salesTable, "year", "DATE")), true);
  assert.equal(isValidSetup(yearly, salesTable), false);
  assert.equal(isValidSetup({ ...yearly, grain: "month" }, withType(salesTable, "year", "TIMESTAMP")), true);
  assert.equal(isValidSetup({ ...yearly, grain: "month" }, salesTable), false);
});

test("a setup with unchosen period, measures and attributes is valid", () => {
  const empty: Setup = { ...workedSetup, unitsColumn: "", salesColumn: "", periodColumn: "", levels: [] };
  assert.equal(isValidSetup(empty, salesTable), true);
});

test("a loaded setup with an empty attribute or filter column is refused", () => {
  assert.equal(isValidSetup({ ...workedSetup, levels: [{ name: "Product", columns: [""] }] }, salesTable), false);
  assert.equal(isValidSetup({ ...workedSetup, filters: [{ column: "", mode: "include", values: ["A"] }] }, salesTable), false);
  assert.equal(isValidSetup({ ...workedSetup, filters: [{ column: "product", mode: "include", values: ["A"] }] }, salesTable), true);
});

test("text net_sales withholds sales instead of falling through to gross_sales", () => {
  const setup = guessSetup([
    { name: "period", type: "VARCHAR" },
    { name: "product", type: "VARCHAR" },
    { name: "units", type: "INTEGER" },
    { name: "net_sales", type: "VARCHAR" },
    { name: "gross_sales", type: "DOUBLE" },
  ]);
  assert.equal(setup.salesColumn, "");
  assert.equal(setup.grossColumn, undefined);
  assert.equal(netSalesHeldAsText(([
    { name: "period", type: "VARCHAR" },
    { name: "product", type: "VARCHAR" },
    { name: "units", type: "INTEGER" },
    { name: "net_sales", type: "VARCHAR" },
    { name: "gross_sales", type: "DOUBLE" },
  ]) satisfies Column[]), "net_sales");
});

test("a numeric net_sales_note keeps the base sales guess beside text net_sales", () => {
  const expected: Setup = {
    periodColumn: "period",
    grain: "value",
    unitsColumn: "units",
    salesColumn: "gross_sales",
    grossColumn: undefined,
    levels: [],
    filters: [],
    fresh: true,
  };
  const forward: Column[] = [
    { name: "period", type: "VARCHAR" },
    { name: "product", type: "VARCHAR" },
    { name: "units", type: "INTEGER" },
    { name: "net_sales", type: "VARCHAR" },
    { name: "gross_sales", type: "DOUBLE" },
    { name: "net_sales_note", type: "DOUBLE" },
  ];
  const backward: Column[] = [
    { name: "period", type: "VARCHAR" },
    { name: "product", type: "VARCHAR" },
    { name: "units", type: "INTEGER" },
    { name: "net_sales_note", type: "DOUBLE" },
    { name: "gross_sales", type: "DOUBLE" },
    { name: "net_sales", type: "VARCHAR" },
  ];
  assert.deepEqual(guessSetup(forward), expected);
  assert.deepEqual(guessSetup(backward), expected);
});

test("a numeric net_revenue stops text net_sales being held and keeps the base sales and gross guess", () => {
  const expected: Setup = {
    periodColumn: "period",
    grain: "value",
    unitsColumn: "units",
    salesColumn: "net_revenue",
    grossColumn: "gross_sales",
    levels: [],
    filters: [],
    fresh: true,
  };
  const forward: Column[] = [
    { name: "period", type: "VARCHAR" },
    { name: "product", type: "VARCHAR" },
    { name: "units", type: "INTEGER" },
    { name: "net_sales", type: "VARCHAR" },
    { name: "net_revenue", type: "DOUBLE" },
    { name: "gross_sales", type: "DOUBLE" },
  ];
  const reversed: Column[] = [
    { name: "period", type: "VARCHAR" },
    { name: "product", type: "VARCHAR" },
    { name: "units", type: "INTEGER" },
    { name: "gross_sales", type: "DOUBLE" },
    { name: "net_revenue", type: "DOUBLE" },
    { name: "net_sales", type: "VARCHAR" },
  ];
  assert.deepEqual(guessSetup(forward), expected);
  assert.deepEqual(guessSetup(reversed), expected);
  // guessSetup asks the helper only when no numeric net column survives the note filter, so this pins the helper's own gate.
  assert.equal(netSalesHeldAsText(forward), "");
  assert.equal(netSalesHeldAsText(reversed), "");
});

test("a text net_sales_unit_price beside numeric sales does not withhold sales", () => {
  for (const name of [
    "net_sales_unit_price",
    "net_sales_price_per_unit",
    "net_sales_unit_cost",
    "netSalesUnitPrice",
  ]) {
    const columns: Column[] = [
      { name: "period", type: "VARCHAR" },
      { name: "product", type: "VARCHAR" },
      { name: "units", type: "INTEGER" },
      { name, type: "VARCHAR" },
      { name: "sales", type: "DOUBLE" },
    ];
    assert.equal(guessSetup(columns).salesColumn, "sales", name);
    assert.equal(guessSetup(columns).grossColumn, undefined, name);
    assert.equal(netSalesHeldAsText(columns), "", name);
  }
});

test("network-like text columns do not withhold sales", () => {
  for (const name of ["network", "internet_channel", "cabinet_type"]) {
    const setup = guessSetup([
      { name: "period", type: "VARCHAR" },
      { name: "product", type: "VARCHAR" },
      { name, type: "VARCHAR" },
      { name: "sales", type: "DOUBLE" },
    ]);
    assert.equal(setup.salesColumn, "sales", name);
  }
});

test("net note, unit price and quantity names do not withhold sales", () => {
  for (const name of ["net_sales_note", "net_unit_price", "NetSalesQty"]) {
    const setup = guessSetup([
      { name: "period", type: "VARCHAR" },
      { name: "product", type: "VARCHAR" },
      { name: "units", type: "INTEGER" },
      { name, type: "VARCHAR" },
      { name: "gross_sales", type: "DOUBLE" },
    ]);
    assert.equal(setup.salesColumn, "gross_sales", name);
    assert.equal(setup.grossColumn, undefined, name);
  }
});

const engines: EngineState[] = ["idle", "loading", "ready", "failed"];

test("the sample link starts reading before the first render", () => {
  assert.equal(initialPhase("?sample").kind, "reading");
  assert.equal(initialPhase("?sample=sku").kind, "reading");
  assert.equal(initialPhase("").kind, "start");
  assert.equal(initialPhase("?other=1").kind, "start");
});

test("a sample load ends on its first bridge and a file load on the workspace", () => {
  let phase = nextPhase(initialPhase(""), { type: "read", load: 1, source: "sample", label: "Making the sample data…" });
  phase = nextPhase(phase, { type: "loaded", load: 1 });
  assert.deepEqual(phase, { kind: "autoRun", load: 1 });
  phase = nextPhase(phase, { type: "ran", load: 1 });
  assert.deepEqual(phase, { kind: "workspace", load: 1 });
  phase = nextPhase(phase, { type: "read", load: 2, source: "file", label: "Reading A-100.csv…" });
  phase = nextPhase(phase, { type: "loaded", load: 2 });
  assert.deepEqual(phase, { kind: "workspace", load: 2 });
});

test("events from an earlier load do not move the phase", () => {
  let phase = nextPhase(initialPhase(""), { type: "read", load: 1, source: "file", label: "Reading first.csv…" });
  phase = nextPhase(phase, { type: "read", load: 2, source: "sample", label: "Making the sample data…" });
  const reading = phase;
  assert.equal(nextPhase(reading, { type: "loaded", load: 1 }), reading);
  assert.equal(nextPhase(reading, { type: "failed", load: 1 }), reading);
  assert.equal(nextPhase(reading, { type: "read", load: 1, source: "file", label: "Reading first.csv…" }), reading);
  phase = nextPhase(reading, { type: "loaded", load: 2 });
  assert.deepEqual(phase, { kind: "autoRun", load: 2 });
  assert.equal(nextPhase(phase, { type: "ran", load: 1 }), phase);
  assert.deepEqual(nextPhase(phase, { type: "ran", load: 2 }), { kind: "workspace", load: 2 });
});

test("a failed load goes back to where the visitor was", () => {
  const first = nextPhase(initialPhase(""), { type: "read", load: 1, source: "file", label: "Reading A-100.csv…" });
  assert.deepEqual(nextPhase(first, { type: "failed", load: 1 }), { kind: "start" });
  const sample = nextPhase(initialPhase("?sample"), { type: "read", load: 1, source: "sample", label: "Making the sample data…" });
  assert.deepEqual(nextPhase(sample, { type: "failed", load: 1 }), { kind: "start" });
  const over = nextPhase({ kind: "workspace", load: 3 }, { type: "read", load: 4, source: "file", label: "Reading North.csv…" });
  assert.deepEqual(nextPhase(over, { type: "failed", load: 4 }), { kind: "workspace", load: 4 });
  const again = nextPhase(over, { type: "read", load: 5, source: "sample", label: "Making the sample data…" });
  assert.deepEqual(nextPhase(again, { type: "failed", load: 5 }), { kind: "workspace", load: 5 });
  assert.deepEqual(nextPhase({ kind: "autoRun", load: 6 }, { type: "failed", load: 6 }), { kind: "workspace", load: 6 });
});

test("main shows the engine sentence until the engine is ready, then what is being read", () => {
  const file: Phase = { kind: "reading", load: 1, source: "file", label: "Reading A-100.csv…", back: "start" };
  const autoRun: Phase = { kind: "autoRun", load: 1 };
  for (const engine of engines) {
    assert.deepEqual(mainView({ kind: "start" }, engine), { kind: "start" });
    assert.deepEqual(mainView({ kind: "workspace", load: 1 }, engine), { kind: "workspace" });
    const ready = engine === "ready";
    assert.deepEqual(mainView(file, engine), { kind: "loading", text: ready ? "Reading A-100.csv…" : ENGINE_LOADING_TEXT });
    assert.deepEqual(mainView(autoRun, engine), { kind: "loading", text: ready ? "Calculating the sample bridge…" : ENGINE_LOADING_TEXT });
  }
  assert.deepEqual(mainView(initialPhase("?sample"), "ready"), { kind: "loading", text: "Making the sample data…" });
  assert.equal(
    ENGINE_LOADING_TEXT,
    "Loading the calculation engine (about 5 MB). On a slow connection this can take a minute or two. Your file is not uploaded.",
  );
});

test("the sample calculates once its own periods are read", () => {
  const autoRun: Phase = { kind: "autoRun", load: 2 };
  assert.equal(shouldAutoRun(autoRun, true, true), true);
  assert.equal(shouldAutoRun(autoRun, true, false), false);
  assert.equal(shouldAutoRun(autoRun, false, true), false);
  assert.equal(shouldAutoRun({ kind: "workspace", load: 2 }, true, true), false);
  assert.equal(shouldAutoRun(initialPhase("?sample"), true, true), false);
});

test("leaving the page warns only while data is loaded or loading", () => {
  assert.equal(shouldWarn({ kind: "start" }, false), false);
  assert.equal(shouldWarn(initialPhase("?sample"), false), true);
  assert.equal(shouldWarn({ kind: "autoRun", load: 1 }, false), true);
  assert.equal(shouldWarn({ kind: "workspace", load: 1 }, false), true);
  assert.equal(shouldWarn({ kind: "workspace", load: 1 }, true), false);
});

const fiscalBase: Setup = {
  periodColumn: "order_date",
  grain: "year",
  unitsColumn: "units",
  salesColumn: "sales",
  levels: [],
  filters: [],
};

test("a setup with missing or 1 gives the same SQL text as today", () => {
  const missing = viewSql(fiscalBase);
  const one = viewSql({ ...fiscalBase, fiscalYearStart: 1 });
  const undef = viewSql({ ...fiscalBase, fiscalYearStart: undefined });
  assert.equal(one, missing);
  assert.equal(undef, missing);
  assert.ok(missing.includes(`strftime("order_date", '%Y')`));
  assert.equal(missing.includes("FY"), false);
  for (const grain of ["ytd", "quarter", "month", "value"] as const) {
    const a = viewSql({ ...fiscalBase, grain });
    const b = viewSql({ ...fiscalBase, grain, fiscalYearStart: 1 });
    const c = viewSql({ ...fiscalBase, grain, fiscalYearStart: undefined });
    assert.equal(b, a, grain);
    assert.equal(c, a, grain);
  }
  const ytd = viewSql({ ...fiscalBase, grain: "ytd" });
  assert.ok(ytd.includes(`strftime("order_date", '%m%d')`));
  const quarter = viewSql({ ...fiscalBase, grain: "quarter" });
  assert.ok(quarter.includes(`quarter("order_date")`));
});

test("isValidSetup accepts missing and 1..12 and rejects the rest", () => {
  const dated: Column[] = [
    { name: "order_date", type: "DATE" },
    { name: "units", type: "INTEGER" },
    { name: "sales", type: "DOUBLE" },
  ];
  assert.equal(isValidSetup(fiscalBase, dated), true);
  for (let m = 1; m <= 12; m++) {
    assert.equal(isValidSetup({ ...fiscalBase, fiscalYearStart: m }, dated), true, `M=${m}`);
  }
  for (const bad of [0, 13, 1.5, NaN, "7", null, true, {}]) {
    assert.equal(isValidSetup({ ...fiscalBase, fiscalYearStart: bad as never }, dated), false, `${String(bad)}`);
  }
  assert.equal(isValidSetup({ ...fiscalBase, grain: "year", fiscalYearStart: 7 }, dated), true);
  assert.equal(isValidSetup({ ...fiscalBase, grain: "year", fiscalYearStart: 0 }, dated), false);
  const noTypes = dated.map((c) => ({ name: c.name, type: "" }));
  assert.equal(isValidSetup({ ...fiscalBase, fiscalYearStart: 7 }, noTypes), true);
  assert.equal(isValidSetup({ ...fiscalBase, fiscalYearStart: 13 }, noTypes), false);
});

test("guessSetup leaves the fiscal year at calendar", () => {
  const setup = guessSetup([
    { name: "order_date", type: "DATE" },
    { name: "units", type: "DOUBLE" },
    { name: "sales", type: "DOUBLE" },
  ]);
  assert.equal(setup.fiscalYearStart, undefined);
  assert.equal("fiscalYearStart" in setup, false);
});

async function fiscalLabels(dates: string[], grain: Setup["grain"], fiscalYearStart?: number): Promise<Map<string, string | null>> {
  const query = await openDatabase();
  await query(`CREATE TABLE data (order_date DATE, product VARCHAR, units INTEGER, sales DOUBLE)`);
  const rows = dates.map((d, i) => `(DATE '${d}', 'A-100', ${i + 1}, ${(i + 1) * 10.0})`).join(", ");
  await query(`INSERT INTO data VALUES ${rows}`);
  const setup: Setup = {
    periodColumn: "order_date",
    grain,
    unitsColumn: "units",
    salesColumn: "sales",
    levels: [],
    filters: [],
    ...(fiscalYearStart === undefined ? {} : { fiscalYearStart }),
  };
  await query(viewSql(setup));
  const out = await query(`SELECT CAST("order_date" AS VARCHAR) AS d, "${PERIOD}" AS p FROM "${VIEW}" ORDER BY "order_date"`);
  return new Map(out.map((row) => [String(row.d), row.p === null ? null : String(row.p)]));
}

test("M=7 year labels name the year they end in", async () => {
  const dates = ["2024-02-29", "2025-06-30", "2025-07-01", "2025-12-31", "2026-01-01", "2026-06-30"];
  const labels = await fiscalLabels(dates, "year", 7);
  assert.equal(labels.get("2025-07-01"), "FY2026");
  assert.equal(labels.get("2026-06-30"), "FY2026");
  assert.equal(labels.get("2025-06-30"), "FY2025");
  assert.equal(labels.get("2024-02-29"), "FY2024");
  assert.equal(labels.get("2025-12-31"), "FY2026");
  assert.equal(labels.get("2026-01-01"), "FY2026");
});

test("M=7 quarter labels start Q1 at the start month", async () => {
  const dates = ["2024-02-29", "2025-06-30", "2025-07-01", "2025-12-31", "2026-01-01", "2026-06-30"];
  const labels = await fiscalLabels(dates, "quarter", 7);
  assert.equal(labels.get("2025-07-01"), "FY2026-Q1");
  assert.equal(labels.get("2026-06-30"), "FY2026-Q4");
  assert.equal(labels.get("2025-06-30"), "FY2025-Q4");
  assert.equal(labels.get("2024-02-29"), "FY2024-Q3");
  assert.equal(labels.get("2025-12-31"), "FY2026-Q2");
  assert.equal(labels.get("2026-01-01"), "FY2026-Q3");
});

test("M=7 YTD labels cut each year at the same fiscal offset", async () => {
  const dates = [
    "2024-02-29",
    "2024-07-01",
    "2025-02-15",
    "2025-03-10",
    "2025-06-30",
    "2025-07-01",
    "2025-12-31",
    "2026-01-01",
    "2026-02-15",
    "2026-03-10",
  ];
  const labels = await fiscalLabels(dates, "ytd", 7);
  assert.equal(labels.get("2024-07-01"), "FY2025 YTD");
  assert.equal(labels.get("2025-02-15"), "FY2025 YTD");
  assert.equal(labels.get("2025-03-10"), "FY2025 YTD");
  assert.equal(labels.get("2025-06-30"), null);
  assert.equal(labels.get("2025-07-01"), "FY2026 YTD");
  assert.equal(labels.get("2025-12-31"), "FY2026 YTD");
  assert.equal(labels.get("2026-01-01"), "FY2026 YTD");
  assert.equal(labels.get("2026-02-15"), "FY2026 YTD");
  assert.equal(labels.get("2026-03-10"), "FY2026 YTD");
  assert.equal(labels.get("2024-02-29"), "FY2024 YTD");
});

test("M=1 year, quarter and YTD labels match the calendar", async () => {
  const dates = ["2024-02-29", "2025-06-30", "2025-07-01", "2025-12-31", "2026-01-01", "2026-06-30"];
  const year = await fiscalLabels(dates, "year", 1);
  assert.equal(year.get("2025-07-01"), "2025");
  assert.equal(year.get("2026-06-30"), "2026");
  assert.equal(year.get("2024-02-29"), "2024");
  const quarter = await fiscalLabels(dates, "quarter", 1);
  assert.equal(quarter.get("2025-07-01"), "2025-Q3");
  assert.equal(quarter.get("2026-06-30"), "2026-Q2");
  assert.equal(quarter.get("2024-02-29"), "2024-Q1");
  const missingYear = await fiscalLabels(dates, "year");
  assert.deepEqual([...missingYear.entries()], [...year.entries()]);
  const ytdDates = ["2025-03-10", "2025-03-11", "2025-06-30", "2026-03-10"];
  const ytd = await fiscalLabels(ytdDates, "ytd", 1);
  assert.equal(ytd.get("2025-03-10"), "2025 YTD");
  assert.equal(ytd.get("2025-03-11"), null);
  assert.equal(ytd.get("2025-06-30"), null);
  assert.equal(ytd.get("2026-03-10"), "2026 YTD");
});

test("fiscal month labels do not change", async () => {
  const dates = ["2025-12-31", "2026-01-01", "2026-06-30"];
  const fiscal = await fiscalLabels(dates, "month", 7);
  const calendar = await fiscalLabels(dates, "month", 1);
  assert.deepEqual([...fiscal.entries()], [["2025-12-31", "2025-12"], ["2026-01-01", "2026-01"], ["2026-06-30", "2026-06"]]);
  assert.deepEqual([...calendar.entries()], [...fiscal.entries()]);
});

test("fiscal SQL uses integer month arithmetic only", () => {
  const sql = viewSql({ ...fiscalBase, grain: "quarter", fiscalYearStart: 7 });
  assert.ok(sql.includes("month("));
  assert.ok(sql.includes("% 12"));
  assert.ok(sql.includes("// 3"));
  for (const banned of ["INTERVAL", "interval", "make_date", "make_timestamp", "to_date", "strptime", "date_trunc"]) {
    assert.equal(sql.includes(banned), false, banned);
  }
  const ytd = viewSql({ ...fiscalBase, grain: "ytd", fiscalYearStart: 7 });
  assert.ok(ytd.includes("month("));
  assert.ok(ytd.includes("day("));
  for (const banned of ["INTERVAL", "make_date", "to_date", "strptime"]) {
    assert.equal(ytd.includes(banned), false, banned);
  }
});

// D143. The guesses a loaded sales file gets, and the one sentence each hint
// carries. Dollar amounts are made up and the products are neutral codes.

const fact = (sum: number) => ({ sum });
const dated = (first: string, last: string, months: number) => ({ first, last, months });

const bottleFile: Column[] = [
  { name: "ordered_on", type: "DATE", facts: dated("2026-08-01", "2026-09-30", 2) },
  { name: "category_name", type: "VARCHAR" },
  { name: "im_desc", type: "VARCHAR" },
  { name: "sales_bottles", type: "BIGINT", facts: fact(1_075_135) },
  { name: "bottle_volume_ml", type: "BIGINT", facts: fact(806_351_250) },
  { name: "sales_dollars", type: "DOUBLE", facts: fact(15_514_108) },
];

test("D143: a bottle count is Units, the money column is Sales, and the bottle size is not Units", () => {
  const setup = guessSetup(bottleFile);
  assert.equal(setup.unitsColumn, "sales_bottles");
  assert.equal(setup.salesColumn, "sales_dollars");
  assert.notEqual(setup.unitsColumn, setup.salesColumn);
  assert.equal(measureNote(bottleFile, setup), null);
});

test("D143: Units and Sales are never the same column", () => {
  const setup = guessSetup([
    { name: "Business Unit Sales", type: "DOUBLE", facts: fact(900) },
    { name: "units", type: "BIGINT", facts: fact(90) },
  ]);
  assert.equal(setup.unitsColumn, "units");
  assert.equal(setup.salesColumn, "");
});

test("D143: French money names are guessed, and two money columns get one hint", () => {
  const file: Column[] = [
    { name: "annee", type: "VARCHAR" },
    { name: "classe", type: "VARCHAR" },
    { name: "boites", type: "BIGINT", facts: fact(216) },
    { name: "montant", type: "DOUBLE", facts: fact(5_600) },
    { name: "chiffre_affaires", type: "DOUBLE", facts: fact(5_500) },
  ];
  const setup = guessSetup(file);
  assert.equal(setup.unitsColumn, "boites");
  assert.equal(setup.salesColumn, "montant");
  assert.deepEqual(measureNote(file, setup), {
    role: "sales",
    sentence: 'Sales is "montant", but "chiffre_affaires" also looks like money; choose it in Sales if you meant that one.',
  });
});

test("D143: Spanish and Dutch money names are guessed", () => {
  assert.equal(measures("importe").salesColumn, "importe");
  assert.equal(measures("omzet").salesColumn, "omzet");
  assert.equal(measures("ventas").salesColumn, "ventas");
  assert.equal(measures("bedrag").salesColumn, "bedrag");
});

test("D143: with no name that says sales, the money column is guessed from its values and said so", () => {
  const file: Column[] = [
    { name: "annee", type: "VARCHAR" },
    { name: "classe", type: "VARCHAR" },
    { name: "boites", type: "BIGINT", facts: fact(216) },
    { name: "alpha", type: "DOUBLE", facts: fact(5_600) },
    { name: "beta", type: "DOUBLE", facts: fact(5_040) },
  ];
  const guess = guessSetup(file);
  assert.equal(guess.salesColumn, "");
  const setup = { ...guess, ...refineGuess(guess, file) };
  assert.equal(setup.salesColumn, "alpha");
  assert.deepEqual(measureNote(file, setup), {
    role: "sales",
    sentence: 'No column of numbers is named like sales, so Sales is "alpha" because its values look like money.',
  });
});

test("D143: a text column named sales leaves the value fallback and says so", () => {
  const file: Column[] = [
    { name: "period", type: "VARCHAR" },
    { name: "product", type: "VARCHAR" },
    { name: "units", type: "BIGINT", facts: fact(20) },
    { name: "sales", type: "VARCHAR" },
    { name: "alpha", type: "DOUBLE", facts: fact(150) },
    { name: "beta", type: "DOUBLE", facts: fact(130) },
  ];
  const guess = guessSetup(file);
  assert.equal(guess.salesColumn, "");
  const setup = { ...guess, ...refineGuess(guess, file) };
  assert.equal(setup.salesColumn, "alpha");
  assert.deepEqual(measureNote(file, setup), {
    role: "sales",
    sentence: 'No column of numbers is named like sales, so Sales is "alpha" because its values look like money.',
  });
});

test("D143: a per-unit price picked as Sales gets one hint and is never blocked", () => {
  const file: Column[] = [
    { name: "Quantity", type: "BIGINT", facts: fact(10_000) },
    { name: "Price", type: "DOUBLE", facts: fact(2_000) },
  ];
  const setup = { ...guessSetup(file), salesColumn: "Price" };
  assert.equal(setup.unitsColumn, "Quantity");
  assert.deepEqual(measureNote(file, setup), {
    role: "sales",
    sentence: 'Sales is "Price", whose name suggests a price, so check that it is the total amount sold.',
  });
});

test("D143: a date file inside one year refines Year to Month", () => {
  const setup = guessSetup(bottleFile);
  assert.equal(setup.grain, "year");
  assert.deepEqual(refineGuess(setup, bottleFile), { grain: "month" });
});

test("D143: dates that span two years keep the Year default", () => {
  const file: Column[] = [
    { name: "sold_on", type: "DATE", facts: dated("2025-01-02", "2026-03-28", 15) },
    { name: "product", type: "VARCHAR" },
    { name: "units", type: "BIGINT", facts: fact(900) },
    { name: "sales", type: "DOUBLE", facts: fact(10_800) },
  ];
  const setup = guessSetup(file);
  assert.equal(setup.grain, "year");
  assert.deepEqual(refineGuess(setup, file), {});
});

test("D143: the one-period gate sentence names the period choice to change", () => {
  const setup = guessSetup(bottleFile);
  const gate = calculateGate({
    setup,
    prior: "",
    current: "2026",
    problem: { kind: "reason", message: 'With these settings "ordered_on" gives only one period, and a bridge compares two periods.' },
    months: 2,
  });
  assert.deepEqual(gate, {
    ready: false,
    reason: 'With these settings "ordered_on" gives only one period, so choose Month in Compare by.',
  });
});

test("D143: the gate names Month only when the file has two months to compare", () => {
  const setup = guessSetup(bottleFile);
  const message = 'With these settings "ordered_on" gives only one period, and a bridge compares two periods.';
  const problem = { kind: "reason" as const, message };
  assert.deepEqual(calculateGate({ setup, prior: "", current: "2026", problem, months: 1 }), {
    ready: false,
    reason: message,
  });
  assert.deepEqual(calculateGate({ setup, prior: "", current: "2026", problem }), {
    ready: false,
    reason: message,
  });
  assert.deepEqual(calculateGate({ setup, prior: "", current: "2026", problem, months: 2 }), {
    ready: false,
    reason: 'With these settings "ordered_on" gives only one period, so choose Month in Compare by.',
  });
});

test("D143: a month grain keeps its one-period sentence as it is", () => {
  const setup = { ...guessSetup(bottleFile), grain: "month" as const };
  const message = 'With these settings "ordered_on" gives only one period, and a bridge compares two periods.';
  assert.equal(calculateGate({ setup, prior: "2026-08", current: "2026-08", problem: { kind: "reason", message } }).ready, false);
  assert.equal(
    (calculateGate({ setup, prior: "", current: "2026-08", problem: { kind: "reason", message } }) as { reason: string }).reason,
    message,
  );
});

test("D143: an empty attribute name falls back to its column, and a row with no column is dropped", () => {
  assert.equal(effectiveName({ name: "", columns: ["model"] }), "model");
  assert.equal(effectiveName({ name: "  ", columns: ["size", "colour"] }), "size + colour");
  assert.equal(effectiveName({ name: "Family", columns: ["model"] }), "Family");
  assert.deepEqual(
    cleanLevels([
      { name: "model", columns: ["model"] },
      { name: "", columns: [] },
      { name: "size", columns: [""] },
    ]).map((level) => level.columns.join("+")),
    ["model"],
  );
});

test("D143: a gross column is for the Gross picker, not a second Sales hint", () => {
  const file: Column[] = [
    { name: "units", type: "BIGINT", facts: fact(90) },
    { name: "gross_sales", type: "DOUBLE", facts: fact(1_200) },
    { name: "net_sales", type: "DOUBLE", facts: fact(900) },
  ];
  const setup = guessSetup(file);
  assert.equal(setup.salesColumn, "net_sales");
  assert.equal(setup.grossColumn, "gross_sales");
  assert.equal(measureNote(file, setup), null);
});

test("D143: a French, German, Spanish or Dutch year column is the period column", () => {
  for (const name of ["annee", "Annee", "Jahr", "Jaar", "Año"]) {
    assert.equal(guessSetup([{ name, type: "BIGINT" }, { name: "boites", type: "BIGINT" }]).periodColumn, name, name);
  }
});

test("D143: a year column is never guessed as Sales from its values", () => {
  const file: Column[] = [
    { name: "annee", type: "BIGINT", facts: fact(8_094) },
    { name: "boites", type: "BIGINT", facts: fact(432) },
    { name: "alpha", type: "DOUBLE", facts: fact(5_600) },
    { name: "beta", type: "DOUBLE", facts: fact(5_040) },
  ];
  const guess = guessSetup(file);
  assert.equal(guess.periodColumn, "annee");
  const setup = { ...guess, ...refineGuess(guess, file) };
  assert.equal(setup.periodColumn, "annee");
  assert.notEqual(setup.salesColumn, "annee");
});

test("D143: a value fallback never picks a price, a cost or a size, and choosing one warns", () => {
  const file: Column[] = [
    { name: "period", type: "VARCHAR" },
    { name: "units", type: "BIGINT", facts: fact(20) },
    { name: "unit_price", type: "DOUBLE", facts: fact(200) },
    { name: "alpha", type: "DOUBLE", facts: fact(150) },
  ];
  const guess = guessSetup(file);
  assert.equal(guess.salesColumn, "");
  assert.deepEqual(refineGuess(guess, file), { salesColumn: "alpha", salesFromValues: "alpha" });
  const chosen = { ...guess, salesColumn: "unit_price" };
  assert.deepEqual(measureNote(file, chosen), {
    role: "sales",
    sentence: 'Sales is "unit_price", whose name suggests a price, so check that it is the total amount sold.',
  });
  for (const name of ["cost_per_case", "bottle_size_ml"]) {
    const withCandidate: Column[] = [...file, { name, type: "DOUBLE", facts: fact(400) }];
    assert.equal(refineGuess(guessSetup(withCandidate), withCandidate).salesColumn, "alpha", name);
  }
});

test("D143: a currency qualifier keeps a money column in Sales, not Units", () => {
  const file: Column[] = [
    { name: "period", type: "VARCHAR" },
    { name: "units", type: "BIGINT", facts: fact(1_000) },
    { name: "Sales (Currency Units)", type: "DOUBLE", facts: fact(500) },
  ];
  const setup = guessSetup(file);
  assert.equal(setup.unitsColumn, "units");
  assert.equal(setup.salesColumn, "Sales (Currency Units)");
  assert.deepEqual(measureNote(file, setup), {
    role: "sales",
    sentence: 'Sales totals less than Units, so "Sales (Currency Units)" may be a per-unit price rather than the amount sold.',
  });
});

test("D143: the value-fallback hint shows only for a fallback that supplied Sales", () => {
  const file: Column[] = [
    { name: "annee", type: "VARCHAR" },
    { name: "boites", type: "BIGINT", facts: fact(216) },
    { name: "alpha", type: "DOUBLE", facts: fact(5_600) },
  ];
  const guess = guessSetup(file);
  const refined = { ...guess, ...refineGuess(guess, file) };
  assert.equal(refined.salesFromValues, "alpha");
  assert.deepEqual(measureNote(file, refined), {
    role: "sales",
    sentence: 'No column of numbers is named like sales, so Sales is "alpha" because its values look like money.',
  });
  assert.equal(measureNote(file, { ...refined, salesFromValues: undefined }), null);
});

test("D143: picking the other measure's column swaps the two", () => {
  const setup: Setup = { ...workedSetup, salesColumn: "net_sales" };
  const afterSales = { ...setup, ...measureChange(setup, "sales", "units") };
  assert.deepEqual([afterSales.unitsColumn, afterSales.salesColumn], ["net_sales", "units"]);
  const afterUnits = { ...afterSales, ...measureChange(afterSales, "units", "net_sales") };
  assert.deepEqual([afterUnits.unitsColumn, afterUnits.salesColumn], ["net_sales", "units"]);
  const swappedUnits = { ...setup, ...measureChange(setup, "units", "net_sales") };
  assert.deepEqual([swappedUnits.unitsColumn, swappedUnits.salesColumn], ["net_sales", "units"]);
  assert.deepEqual(measureChange(setup, "units", "amount"), { unitsColumn: "amount" });
});

test("D143: only a fresh guess refines, and a fiscal start that already splits the year stays on Year", () => {
  const file: Column[] = [
    { name: "ordered_on", type: "DATE", facts: dated("2026-01-05", "2026-03-20", 3) },
    { name: "units", type: "BIGINT", facts: fact(90) },
    { name: "sales", type: "DOUBLE", facts: fact(1_200) },
  ];
  const guess = guessSetup(file);
  assert.equal(guess.fresh, true);
  assert.equal(guess.grain, "year");
  assert.deepEqual(refineGuess({ ...guess, fresh: undefined }, file), {});
  assert.deepEqual(refineGuess({ ...guess, fiscalYearStart: 2 }, file), {});
  assert.deepEqual(refineGuess(guess, file), { grain: "month" });
});

test("T430: a count-named Units does not hide that a guessed Sales came from its values", () => {
  const file: Column[] = [
    { name: "period", type: "VARCHAR" },
    { name: "Sales Qty", type: "BIGINT", facts: fact(216) },
    { name: "alpha", type: "DOUBLE", facts: fact(5_600) },
  ];
  const guess = guessSetup(file);
  assert.equal(guess.unitsColumn, "Sales Qty");
  assert.equal(guess.salesColumn, "");
  const setup = { ...guess, ...refineGuess(guess, file) };
  assert.equal(setup.salesColumn, "alpha");
  assert.deepEqual(measureNote(file, setup), {
    role: "sales",
    sentence: 'No column of numbers is named like sales, so Sales is "alpha" because its values look like money.',
  });
});
