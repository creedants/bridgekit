// Checks the `has` and `lacks` claims in DEPLOY.md against the repo, per the
// rules in that file's "Checking this file" section.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A citation is a repo path with an optional line or line span.
const CITATION = /^[\w./-]+(?::(\d+)(?:-(\d+))?)?$/;
// A claim is a citation in backticks, the verb, then one or more quoted runs.
const CLAIM = /`([^`\n]+)`[ \t]+(has|lacks)[ \t]+/g;

/** Finds every claim, plus every candidate that reads like a claim but does not parse. */
export function parseClaims(text) {
  const claims = [];
  const skipped = [];
  for (const [index, line] of text.split("\n").entries()) {
    const number = index + 1;
    for (const match of line.matchAll(CLAIM)) {
      const citation = match[1];
      if (/\s/.test(citation)) {
        skipped.push({ line: number, citation, reason: "citation contains whitespace" });
        continue;
      }
      const shape = CITATION.exec(citation);
      if (shape === null) {
        skipped.push({ line: number, citation, reason: "citation is not a path with an optional line number" });
        continue;
      }
      const runs = parseRuns(line, match.index + match[0].length);
      if (runs.length === 0) {
        skipped.push({ line: number, citation, reason: "no quoted run after the verb" });
        continue;
      }
      claims.push({
        line: number,
        citation,
        path: citation.replace(/:\d+(?:-\d+)?$/, ""),
        start: shape[1] === undefined ? null : Number(shape[1]),
        end: shape[1] === undefined ? null : Number(shape[2] ?? shape[1]),
        verb: match[2],
        runs,
      });
    }
  }
  return { claims, skipped };
}

/** Reads the quoted runs that follow the verb, separated by commas. */
function parseRuns(line, start) {
  const runs = [];
  let at = start;
  for (;;) {
    while (line[at] === " " || line[at] === "\t") at += 1;
    if (line[at] !== "`") break;
    const close = line.indexOf("`", at + 1);
    if (close === -1) break;
    runs.push(line.slice(at + 1, close));
    at = close + 1;
    while (line[at] === " " || line[at] === "\t") at += 1;
    if (line[at] === ",") {
      at += 1;
      continue;
    }
    break;
  }
  return runs;
}

/** Reads the cited lines and joins them with single spaces. */
function span(file, claim, root) {
  const text = readFileSync(resolve(root, file), "utf8");
  if (claim.start === null) return text.replace(/\s+/g, " ");
  const lines = text.split("\n");
  if (claim.end > lines.length) {
    throw new Error(`the file has ${lines.length} lines`);
  }
  return lines
    .slice(claim.start - 1, claim.end)
    .join(" ")
    .replace(/\s+/g, " ");
}

/** Checks parsed claims. A claim that cannot be read fails, so a moved file is never silent. */
export function checkClaims(claims, root = process.cwd()) {
  const failures = [];
  const skipped = [];
  let checked = 0;
  for (const claim of claims) {
    // Rule 3: a lacks claim on a line span needs a has claim on the same span,
    // or its absence says nothing about the lines the reader was sent to.
    if (claim.verb === "lacks" && claim.start !== null && !anchored(claim, claims)) {
      skipped.push({ line: claim.line, citation: claim.citation, reason: "lacks on a line span with no anchor" });
      continue;
    }
    let text;
    try {
      text = span(claim.path, claim, root);
    } catch (error) {
      const reason = error.code === "ENOENT" ? "cited file does not exist" : error.message;
      failures.push({ line: claim.line, citation: claim.citation, verb: claim.verb, run: null, reason });
      continue;
    }
    checked += 1;
    for (const run of claim.runs) {
      const present = text.includes(run);
      if (claim.verb === "has" && !present) {
        failures.push({ ...claim, run, reason: "quoted run is not in the cited lines" });
      }
      if (claim.verb === "lacks" && present) {
        failures.push({ ...claim, run, reason: "quoted run is in the cited lines" });
      }
    }
  }
  return { checked, failures, skipped };
}

function anchored(claim, claims) {
  return claims.some(
    (other) =>
      other.verb === "has" &&
      other.line === claim.line &&
      other.path === claim.path &&
      other.start === claim.start &&
      other.end === claim.end,
  );
}

export function checkDoc(text, root = process.cwd()) {
  const { claims, skipped } = parseClaims(text);
  const result = checkClaims(claims, root);
  return { ...result, skipped: [...skipped, ...result.skipped], total: claims.length };
}

function main(argv) {
  const file = argv[2] ?? "DEPLOY.md";
  const result = checkDoc(readFileSync(file, "utf8"), process.cwd());
  for (const failure of result.failures) {
    const run = failure.run === null ? "" : ` \`${failure.run}\``;
    console.log(`${file}:${failure.line}: ${failure.citation} ${failure.verb}${run}: ${failure.reason}`);
  }
  for (const entry of result.skipped) {
    console.log(`${file}:${entry.line}: skipped ${entry.citation}: ${entry.reason}`);
  }
  console.log(
    `${result.total} claims, ${result.checked} checked, ${result.failures.length} failed, ${result.skipped.length} skipped.`,
  );
  return result.failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
