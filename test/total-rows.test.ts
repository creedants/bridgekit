import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findTotalRows,
  profileFile,
  totalRowOffers,
  type FileProfile,
} from "../src/app/profile.ts";
import { TABLE, type Column, type Filter, type Setup } from "../src/app/setup.ts";
import { openDatabase } from "../src/duckdb.ts";
import type { Query } from "../src/engine.ts";

function setupOf(periodColumn: string, levels: string[][], filters: Filter[] = []): Setup {
  return {
    periodColumn,
    grain: "value",
    unitsColumn: "units",
    salesColumn: "sales",
    levels: levels.map((columns) => ({ name: columns[0], columns })),
    filters,
  };
}

async function load(values: (string | number)[][], columns: string): Promise<Query> {
  const query = await openDatabase();
  const rows = values.map((row) => `(${row.map((v) => (typeof v === "number" ? v : `'${v}'`)).join(", ")})`);
  await query(`CREATE TABLE ${TABLE} AS SELECT * FROM (VALUES ${rows.join(", ")}) v(${columns})`);
  return query;
}

async function columnsOf(query: Query): Promise<Column[]> {
  const described = await query(`DESCRIBE ${TABLE}`);
  return described.map((row) => ({ name: String(row.column_name), type: String(row.column_type) }));
}

async function hierarchical(): Promise<Query> {
  return load(
    [
      ["P1", "F1", "C1"],
      ["P2", "F1", "C1"],
      ["P3", "F2", "C1"],
      ["P4", "F3", "C2"],
    ],
    "product, family, category",
  );
}

test("every total spelling and case is found with its row count", async () => {
  const spellings: [string, number][] = [
    ["Total", 1],
    ["TOTALS", 2],
    ["grand total", 3],
    ["Grand Total", 4],
    ["Subtotal", 5],
    ["sub-total", 6],
    ["Sub Total", 7],
  ];
  const rows: (string | number)[][] = [
    ["2024", "P-101", "Family A", 1, 10],
    ["2025", "P-102", "Family A", 1, 10],
  ];
  for (const [value, times] of spellings) {
    for (let i = 0; i < times; i++) rows.push(["2024", value, "Family A", 1, 10]);
  }
  const query = await load(rows, "period, product, family, units, sales");
  assert.deepEqual(await findTotalRows(query, TABLE, setupOf("period", [["product"]])), [
    { column: "product", value: "Sub Total", rows: 7 },
    { column: "product", value: "sub-total", rows: 6 },
    { column: "product", value: "Subtotal", rows: 5 },
    { column: "product", value: "Grand Total", rows: 4 },
    { column: "product", value: "grand total", rows: 3 },
    { column: "product", value: "TOTALS", rows: 2 },
    { column: "product", value: "Total", rows: 1 },
  ]);
});

test("a trailing colon and surrounding spaces still match, and the raw value comes back", async () => {
  const query = await load(
    [
      ["2024", "  Grand Total:  ", 1, 10],
      ["2025", "  Grand Total:  ", 1, 10],
    ],
    "period, product, units, sales",
  );
  assert.deepEqual(await findTotalRows(query, TABLE, setupOf("period", [["product"]])), [
    { column: "product", value: "  Grand Total:  ", rows: 2 },
  ]);
});

test("a total value only in a level column leaves the period column out", async () => {
  const query = await load(
    [
      ["2024", "P-101", 1, 10],
      ["2025", "Grand Total", 1, 10],
    ],
    "period, product, units, sales",
  );
  assert.deepEqual(await findTotalRows(query, TABLE, setupOf("period", [["product"]])), [
    { column: "product", value: "Grand Total", rows: 1 },
  ]);
});

test("a column that is neither the period nor a level column is ignored", async () => {
  const query = await load(
    [
      ["2024", "P-101", "Total", 1, 10],
      ["2025", "P-102", "Total", 1, 10],
    ],
    "period, product, notes, units, sales",
  );
  assert.deepEqual(await findTotalRows(query, TABLE, setupOf("period", [["product"]])), []);
});

test("a failing query yields no totals", async () => {
  const failing: Query = async () => {
    throw new Error("no such table");
  };
  assert.deepEqual(await findTotalRows(failing, TABLE, setupOf("period", [["product"]])), []);
});

test("one query covers every candidate column", async () => {
  const query = await load(
    [
      ["2024", "P-101", "Family A", 1, 10],
      ["Total", "P-102", "Family B", 1, 10],
      ["2024", "P-103", "Grand Total", 1, 10],
    ],
    "period, product, family, units, sales",
  );
  let calls = 0;
  const counted: Query = (sql) => {
    calls += 1;
    return query(sql);
  };
  assert.deepEqual(
    await findTotalRows(counted, TABLE, setupOf("period", [["product"], ["product", "family"]])),
    [
      { column: "period", value: "Total", rows: 1 },
      { column: "family", value: "Grand Total", rows: 1 },
    ],
  );
  assert.equal(calls, 1);
});

test("one row gets the singular sentence and button", () => {
  const [offer] = totalRowOffers([{ column: "product", value: "Total", rows: 1 }], []);
  assert.equal(
    offer.sentence,
    '1 row has "Total" in product. It looks like a total row, which would count the same amounts twice.',
  );
  assert.equal(offer.button, "Leave this row out");
});

test("several rows get the plural sentence with a grouped count", () => {
  const [offer] = totalRowOffers([{ column: "product", value: "Grand Total", rows: 1_234 }], []);
  assert.equal(
    offer.sentence,
    '1,234 rows have "Grand Total" in product. They look like total rows, which would count the same amounts twice.',
  );
  assert.equal(offer.button, "Leave these rows out");
});

test("a column with no filter gains an exclude filter and the others stay unchanged", () => {
  const filters: Filter[] = [{ column: "family", mode: "exclude", values: ["Family Z"] }];
  const [offer] = totalRowOffers([{ column: "product", value: "Total", rows: 2 }], filters);
  assert.deepEqual(offer.filters, [
    { column: "family", mode: "exclude", values: ["Family Z"] },
    { column: "product", mode: "exclude", values: ["Total"] },
  ]);
  assert.deepEqual(filters, [{ column: "family", mode: "exclude", values: ["Family Z"] }]);
});

test("an existing exclude filter takes the value and other filters stay unchanged", () => {
  const filters: Filter[] = [
    { column: "product", mode: "exclude", values: ["P-900"] },
    { column: "family", mode: "exclude", values: ["Family Z"] },
  ];
  const [offer] = totalRowOffers([{ column: "product", value: "Total", rows: 2 }], filters);
  assert.deepEqual(offer.filters, [
    { column: "product", mode: "exclude", values: ["P-900", "Total"] },
    { column: "family", mode: "exclude", values: ["Family Z"] },
  ]);
});

test("an already excluded value gets no offer", () => {
  assert.deepEqual(
    totalRowOffers([{ column: "product", value: "Total", rows: 2 }], [
      { column: "product", mode: "exclude", values: ["Total"] },
    ]),
    [],
  );
});

test("a column with an include filter gets no offer", () => {
  assert.deepEqual(
    totalRowOffers([{ column: "product", value: "Total", rows: 2 }], [
      { column: "product", mode: "include", values: ["P-101"] },
    ]),
    [],
  );
});

test("a profile for a file that is no longer current is dropped", async () => {
  const query = await hierarchical();
  const columns = await columnsOf(query);
  let current = true;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const held: Query = async (sql) => {
    calls += 1;
    if (calls === 1) await gate;
    return query(sql);
  };
  const applied: FileProfile[] = [];
  const running = profileFile(held, columns, () => current, (profile) => applied.push(profile));
  assert.equal(calls, 1);
  current = false;
  release();
  await running;
  assert.deepEqual(applied, []);
});

test("a current profile applies the distinct counts and the roll-ups", async () => {
  const query = await hierarchical();
  const columns = await columnsOf(query);
  const applied: FileProfile[] = [];
  await profileFile(query, columns, () => true, (profile) => applied.push(profile));
  assert.equal(applied.length, 1);
  assert.deepEqual(
    applied[0].columns.map((column) => [column.name, column.distinct]),
    [
      ["product", 4],
      ["family", 3],
      ["category", 2],
    ],
  );
  assert.deepEqual(applied[0].rollups, [["category", "family", "product"]]);
});
