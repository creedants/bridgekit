import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { totalRowOffers } from "../src/app/profile.ts";
import { columnsKey, isValidSetup, loadSavedSetup, saveSetup, type Column, type Filter, type Setup } from "../src/app/setup.ts";

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

beforeEach(() => stored.clear());

const COLUMNS: Column[] = [
  { name: "year", type: "BIGINT" },
  { name: "units", type: "BIGINT" },
  { name: "sales", type: "DOUBLE" },
  { name: "design", type: "VARCHAR" },
];

const SETUP: Setup = {
  periodColumn: "year",
  grain: "value",
  unitsColumn: "units",
  salesColumn: "sales",
  levels: [{ name: "Design", columns: ["design"] }],
  filters: [],
};

test("restores a 301-character attribute name typed in the editor", () => {
  const setup: Setup = { ...SETUP, levels: [{ ...SETUP.levels[0], name: "N".repeat(301) }] };
  assert.equal(isValidSetup(setup, COLUMNS), true);
  saveSetup(COLUMNS, setup);
  const restored = loadSavedSetup(COLUMNS);
  assert.equal(restored?.levels[0]?.name, "N".repeat(301));
});

test("restores a 400-character header name after its chip is removed", () => {
  const header = "h".repeat(400);
  const columns = [...COLUMNS, { name: header, type: "VARCHAR" }];
  const setup: Setup = {
    ...SETUP,
    levels: [{ name: header, columns: ["design"] }],
  };
  assert.equal(isValidSetup(setup, columns), true);
  saveSetup(columns, setup);
  const restored = loadSavedSetup(columns);
  assert.equal(restored?.levels[0]?.name, header);
});

test("accepts a 301-character filter value after a file round trip", () => {
  const setup: Setup = {
    ...SETUP,
    filters: [{ column: "design", mode: "include", values: ["P".repeat(301)] }],
  };
  const roundTripped: unknown = JSON.parse(JSON.stringify(setup));
  assert.equal(isValidSetup(roundTripped, COLUMNS), true);
});

test("accepts the 501st total-row value offered for a 500-value filter", () => {
  const filters: Filter[] = [
    { column: "design", mode: "exclude", values: Array.from({ length: 500 }, (_, index) => `value-${index}`) },
  ];
  const offers = totalRowOffers([{ column: "design", value: "total", rows: 1 }], filters);
  assert.equal(offers.length, 1);
  const offered = offers[0].filters.find((filter) => filter.column === "design");
  assert.equal(offered?.values.length, 501);
  const setup: Setup = { ...SETUP, filters: offers[0].filters };
  assert.equal(isValidSetup(setup, COLUMNS), true);
});

test("drops filters from a remembered mapping that holds a 301-character value", () => {
  const key = `bridgekit:setup:${columnsKey(COLUMNS.map((column) => column.name))}`;
  const remembered = {
    ...SETUP,
    filters: [{ column: "design", mode: "include", values: ["V".repeat(301)] }],
  };
  localStorage.setItem(key, JSON.stringify(remembered));
  const restored = loadSavedSetup(COLUMNS);
  assert.notEqual(restored, null);
  assert.deepEqual(restored?.filters, []);
});

test("accepts 1,001 levels over 1,001 columns", () => {
  const names = Array.from({ length: 1001 }, (_, index) => `column-${index}`);
  const setup: Setup = {
    ...SETUP,
    periodColumn: "",
    unitsColumn: "",
    salesColumn: "",
    levels: names.map((name) => ({ name, columns: [name] })),
  };
  assert.equal(isValidSetup(setup, names.map((name) => ({ name, type: "" }))), true);
});
