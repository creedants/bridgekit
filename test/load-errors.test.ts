import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("?url")) {
      return { url: "data:text/javascript,export default \"stub\"", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { TOO_BIG_SENTENCE, isOutOfMemory, loadFailure } = await import("../src/app/db.ts");

const TOO_BIG = "This file is too big to open in this browser. Try a smaller file, or save it with fewer rows or columns.";
const OUT_OF_MEMORY = "Out of Memory Error: Allocation failure";

test("the too-big sentence is the approved wording", () => {
  assert.equal(TOO_BIG_SENTENCE, TOO_BIG);
});

test("DuckDB's out-of-memory exception is recognised", () => {
  assert.equal(isOutOfMemory(new Error(OUT_OF_MEMORY)), true);
});

test("ordinary load errors are not out-of-memory failures", () => {
  assert.equal(isOutOfMemory(new Error("Invalid Input Error: CSV Error on Line: 2")), false);
  assert.equal(isOutOfMemory(new Error("This file's text encoding could not be read. Save it as CSV UTF-8.")), false);
});

test("an ordinary error that quotes the text is not an out-of-memory failure", () => {
  const quoted = new Error('Conversion Error: Could not convert string "Out of Memory Error" to INT32');
  assert.equal(isOutOfMemory(quoted), false);
});

test("an out-of-memory load shows only the too-big sentence", () => {
  const failure = loadFailure(new Error(OUT_OF_MEMORY));
  assert.ok(failure instanceof Error);
  assert.equal(failure.message, TOO_BIG);
});

test("an ordinary load error is returned unchanged", () => {
  const original = new Error("Invalid Input Error: CSV Error on Line: 2");
  assert.equal(loadFailure(original), original);
});
