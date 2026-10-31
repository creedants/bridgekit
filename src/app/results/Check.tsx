import { useEffect, useState } from "react";
import { measureName, tieOutLines, type Query } from "../../engine.ts";
import { dateOrderNote } from "../db.ts";
import { whole } from "../format.ts";
import { decimalCommaNote, wholeRowNote } from "../numbers.ts";
import { terms } from "../report.ts";
import type { Run } from "../Results.tsx";
import { TABLE } from "../setup.ts";
import { agree } from "../SetupPanel.tsx";
import { QueryFailed, useLoad } from "./shared.tsx";

export function Check(props: {
  run: Run;
  warnings: string[];
  warningsKnown: boolean;
  warningsFailed: boolean;
  query: () => Promise<Query>;
}) {
  const { check, config, ms, tieOut: money } = props.run;
  const tieOut = tieOutLines(config, money, props.run.result);
  const { loaded, failed } = useLoad(
    props.run,
    () => props.query().then((query) => dataCheckNotes(query, TABLE, props.run.formulaBlanks)),
    [props.run],
  );
  const notes = loaded?.key === props.run ? loaded.value : [];
  const lines: [string, number][] = [
    ["Rows read (after filters)", check.rows],
    [`Rows in ${config.prior}`, check.priorRows],
    [`Rows in ${config.current}`, check.currentRows],
    ["Rows in other periods (ignored)", check.otherPeriodRows],
    ["Rows with a blank period (ignored)", check.blankPeriodRows],
    ["Rows with blank units or sales", check.blankMeasureRows],
    ["Rows with negative units", check.negativeUnitRows],
    ["Rows with negative sales", check.negativeSalesRows],
    ["Rows with sales but zero units", check.zeroUnitSalesRows],
  ];
  return (
    <div className="data-check">
      <h3>Money tie-out</h3>
      <p className="hint">
        Money tie-out: for each period, the file total minus what the filters removed equals the {measureName(config).toLowerCase()} in the bridge.
      </p>
      <table className="narrow tieout">
        <tbody>
          {tieOut.map((line) => (
            <tr key={line.label}><td>{line.label}</td><td className="num">{Number.isFinite(line.value) ? whole(line.value) : ""}</td></tr>
          ))}
        </tbody>
      </table>
      {props.warningsKnown && props.warningsFailed && <p className="hint">{WHOLE_ROW_FAILED}</p>}
      {!props.warningsKnown ? null : props.warnings.length > 0 ? (
        <ul className="warnings">{props.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
      ) : !props.warningsFailed ? (
        <p className="ok">No issues found in the rows used.</p>
      ) : null}
      {failed ? <QueryFailed /> : notes.map((sentence) => <p className="hint" key={sentence}>{sentence}</p>)}
      <table className="narrow">
        <tbody>
          {lines.map(([label, value]) => (
            <tr key={label}><td>{label}</td><td className="num">{whole(value)}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="hint">Calculated in {ms.toFixed(0)} ms.</p>
    </div>
  );
}

export function checkWarnings(run: Run, fileWarnings: string[] = []): string[] {
  const { check, config, result } = run;
  const t = terms(config);
  const exact = result.coverage.find((c) => c.level === config.levels.length)?.share ?? 0;
  const warnings: string[] = [];
  if (check.blankMeasureRows > 0) {
    const n = check.blankMeasureRows;
    warnings.push(`${whole(n)} ${agree(n, "row")} ${agree(n, "has", "have")} blank units or sales and ${agree(n, "counts", "count")} as zero.`);
  }
  if (check.negativeUnitRows > 0) {
    const n = check.negativeUnitRows;
    warnings.push(`${whole(n)} ${agree(n, "row")} ${agree(n, "has", "have")} negative units (returns or credits). They are netted against sales of the same configuration.`);
  }
  if (check.zeroUnitSalesRows > 0) {
    const n = check.zeroUnitSalesRows;
    warnings.push(`${whole(n)} ${agree(n, "row")} ${agree(n, "has", "have")} sales but zero units (rebates, credits or fees). ${agree(n, "It is", "They are")} bridged on ${agree(n, "its", "their")} own line, “Sales with no units”, and kept out of price.`);
  }
  if (check.blankPeriodRows > 0) {
    const n = check.blankPeriodRows;
    warnings.push(`${whole(n)} ${agree(n, "row")} ${agree(n, "has", "have")} a blank period and ${agree(n, "is", "are")} ignored.`);
  }
  if (exact < 0.7) {
    warnings.push(t.lowMatch(exact));
  }
  return [...warnings, ...fileWarnings];
}

export const WHOLE_ROW_FAILED = "Could not finish checking the rows used. Choose Calculate bridge again.";

/** The whole-row note, and whether its query answered rather than only returning no note. */
export type WholeRowCheck = { readonly warnings: string[]; readonly failed: boolean };

interface WholeRowLookup {
  readonly check: Promise<WholeRowCheck>;
  readonly warnings: Promise<string[]>;
}

/** One whole-row lookup per result: App builds a fresh query callback on every render. */
const wholeRowLookups = new WeakMap<Run, WholeRowLookup>();

function wholeRowLookup(run: Run, query: () => Promise<Query>): WholeRowLookup {
  const cached = wholeRowLookups.get(run);
  if (cached) return cached;
  // wholeRowNote answers null for its own failure too, so the rejection is read
  // at the query handed to it rather than from the promise it returns.
  let failed = false;
  const watched = (q: Query): Query => (sql) =>
    q(sql).catch((error: unknown) => {
      failed = true;
      throw error;
    });
  const check: Promise<WholeRowCheck> = query()
    .then((q) => wholeRowNote(watched(q), TABLE))
    .then((note) => ({ warnings: note ? [note] : [], failed }))
    .catch(() => ({ warnings: [], failed: true }));
  const lookup = { check, warnings: check.then((answered) => answered.warnings) };
  wholeRowLookups.set(run, lookup);
  return lookup;
}

/** The whole-row note and whether its query answered, for the Data check. */
export function wholeRowCheckFor(run: Run, query: () => Promise<Query>): Promise<WholeRowCheck> {
  return wholeRowLookup(run, query).check;
}

/** The whole-row note as a tab warning, which is all the tab badge counts. */
export function wholeRowWarningsFor(run: Run, query: () => Promise<Query>): Promise<string[]> {
  return wholeRowLookup(run, query).warnings;
}

/**
 * Loads the whole-row note for the Data check tab badge. The note lives in
 * the warnings, so the tab count includes it, while the notes list below
 * omits this warning. A slow reply from a replaced file changes nothing.
 * `resolved` turns true once the note's query has answered either way, so the
 * tab does not say it found no issues before it has looked.
 */
export function useWholeRowWarning(
  run: Run,
  query: () => Promise<Query>,
): { warnings: string[]; failed: boolean; resolved: boolean } {
  const [state, setState] = useState<{ warnings: string[]; failed: boolean; resolved: boolean }>({
    warnings: [],
    failed: false,
    resolved: false,
  });
  useEffect(() => {
    let stale = false;
    setState({ warnings: [], failed: false, resolved: false });
    wholeRowCheckFor(run, query).then(({ warnings, failed }) => {
      if (!stale) setState({ warnings, failed, resolved: true });
    });
    return () => {
      stale = true;
    };
  }, [run]);
  return state;
}

/** The Data check's sentences about how the file was read, in the order the tab shows them. */
export async function dataCheckNotes(query: Query, table: string, formulaBlanks = 0): Promise<string[]> {
  // One note's query failing must not hide the other's sentence. The whole-row
  // note loads as a tab warning instead, so it is left out here.
  const sentences = [
    await decimalCommaNote(query, table, false).catch(() => null),
    await dateOrderNote(query, table).catch(() => null),
  ];
  const read = sentences.filter((sentence): sentence is string => sentence !== null);
  if (formulaBlanks > 0) read.push(formulaBlankNote(formulaBlanks));
  return read;
}

function formulaBlankNote(count: number): string {
  const formatted = count.toLocaleString("en-US");
  if (count === 1) {
    return "1 cell in the Excel file holds a formula with no saved result, so it was read as blank. Open and save the file in Excel, then load it again.";
  }
  return `${formatted} cells in the Excel file hold a formula with no saved result, so they were read as blank. Open and save the file in Excel, then load it again.`;
}
