import assert from "node:assert/strict";
import { test } from "node:test";
import {
  guessSetup,
  isDate,
  isNumeric,
  isValidSetup,
  loadSavedSetup,
  netSalesHeldAsText,
  saveSetup,
  type Column,
  type Setup,
} from "../src/app/setup.ts";

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
  assert.equal(setup.salesColumn, "Business Unit Sales");
  assert.equal(setup.grossColumn, undefined);
});

test("kept Sales Volume (USD)", () => {
  const setup = measures("Sales Volume (USD)");
  assert.equal(setup.unitsColumn, "Sales Volume (USD)");
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

test("oracle headers match the legacy guess outside excluded words", () => {
  for (const row of headers) {
    const columns: Column[] = row.names.map((name) => ({
      name,
      type: row.textMeasures || textNames.has(name) ? "VARCHAR" : "DOUBLE",
    }));
    const message = row.names.join(", ");
    const actual = guessSetup(columns);
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
});

// The remembered and loaded paths read localStorage at call time, so a stub
// replaces it for this file only.
const stored = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
    key: (index: number) => [...stored.keys()][index] ?? null,
    get length() {
      return stored.size;
    },
    clear: () => stored.clear(),
  },
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
  saveSetup(salesTable, workedSetup);
  assert.deepEqual(loadSavedSetup(salesTable), workedSetup);
  assert.equal(loadSavedSetup(withType(salesTable, "sales", "VARCHAR")), null);
});

test("a remembered setup is dropped when its date grain meets a BIGINT period column", () => {
  stored.clear();
  const dated: Column[] = withType(salesTable, "year", "DATE");
  const yearly: Setup = { ...workedSetup, grain: "year" };
  saveSetup(dated, yearly);
  assert.deepEqual(loadSavedSetup(dated), yearly);
  assert.equal(loadSavedSetup(salesTable), null);
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
