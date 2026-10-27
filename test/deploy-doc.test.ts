import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

type Failure = { line: number; citation: string; verb: string; run: string | null; reason: string };
type Skip = { line: number; citation: string; reason: string };
type Result = { total: number; checked: number; failures: Failure[]; skipped: Skip[] };

const checker = new URL("../scripts/check-deploy-doc.mjs", import.meta.url);
const { checkDoc } = (await import(checker.href)) as { checkDoc: (text: string, root: string) => Result };

const files = {
  "notes.txt": "first line\nsecond line here\nthird line\n",
  "join.txt": "alpha\n   beta\n",
};

async function fixture(): Promise<string> {
  const directory = await mkdtemp("/tmp/bridgekit-deploy-doc-");
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(directory, name), content);
  }
  return directory;
}

test("a quoted run in the cited line passes", async () => {
  const root = await fixture();
  const result = checkDoc("- Source: `notes.txt:1` has `first line`.\n", root);
  assert.equal(result.total, 1);
  assert.equal(result.checked, 1);
  assert.deepEqual(result.failures, []);
});

test("a quoted run absent from the cited line fails with the doc line", async () => {
  const root = await fixture();
  const result = checkDoc("- Source: `notes.txt:1` has `second line`.\n", root);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.line, 1);
  assert.equal(result.failures[0]?.citation, "notes.txt:1");
  assert.equal(result.failures[0]?.run, "second line");
});

test("every quoted run of one claim is checked", async () => {
  const root = await fixture();
  const result = checkDoc("- Source: `notes.txt:1` has `first line`, `zebra`.\n", root);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.run, "zebra");
});

test("a line span joins its lines with single spaces", async () => {
  const root = await fixture();
  const result = checkDoc("- Source: `notes.txt:1-2` has `first line`, `second line here`.\n", root);
  assert.deepEqual(result.failures, []);
});

test("whitespace across a line break reads as one space", async () => {
  const root = await fixture();
  const result = checkDoc("- Source: `join.txt:1-2` has `alpha beta`.\n", root);
  assert.deepEqual(result.failures, []);
});

test("a lacks claim passes when the run is absent from the cited line", async () => {
  const root = await fixture();
  const result = checkDoc("- Source: `notes.txt:1` has `first line`. `notes.txt:1` lacks `zebra`.\n", root);
  assert.deepEqual(result.failures, []);
});

test("a lacks claim fails when the run is in the cited line", async () => {
  const root = await fixture();
  const result = checkDoc("- Source: `notes.txt:1` has `first line`. `notes.txt:1` lacks `first line`.\n", root);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.verb, "lacks");
  assert.equal(result.failures[0]?.reason, "quoted run is in the cited lines");
});

test("a lacks claim with no line number reads the whole file", async () => {
  const root = await fixture();
  const absent = checkDoc("- Source: `notes.txt` lacks `zebra`.\n", root);
  assert.deepEqual(absent.failures, []);
  const present = checkDoc("- Source: `notes.txt` lacks `third line`.\n", root);
  assert.equal(present.failures.length, 1);
  assert.equal(present.failures[0]?.citation, "notes.txt");
});

test("a lacks claim on a line span without an anchor is skipped, not guessed", async () => {
  const root = await fixture();
  const result = checkDoc("- Source: `notes.txt:1-2` lacks `zebra`.\n", root);
  assert.deepEqual(result.failures, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.reason, "lacks on a line span with no anchor");
});

test("a claim with no quoted run is skipped and counted", async () => {
  const root = await fixture();
  const result = checkDoc("- Source: `notes.txt:1` has nothing quoted.\n", root);
  assert.deepEqual(result.failures, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.reason, "no quoted run after the verb");
});

test("a citation past the end of the file fails rather than passing silently", async () => {
  const root = await fixture();
  const result = checkDoc("- Source: `notes.txt:99` has `first line`.\n", root);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.reason, "the file has 4 lines");
});

test("a citation to a file that is gone fails", async () => {
  const root = await fixture();
  const result = checkDoc("- Source: `gone.txt:1` has `only line`.\n", root);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.reason, "cited file does not exist");
});
