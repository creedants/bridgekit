import { useEffect, useState, type DependencyList } from "react";
import { coverageLabel, type BridgeConfig } from "../../engine.ts";
import { finiteOrBlank } from "../exportExcel.ts";
import { saveOnce, shorten, toExportCsv, toExportTsv } from "../files.ts";

export const display = (value: unknown) => (value === null || value === undefined ? "(blank)" : String(value));

export const QUERY_FAILED = "Could not calculate this view. Choose Calculate bridge again.";

/** The one sentence every result panel shows when its query rejects. */
export function QueryFailed() {
  return <p className="hint">{QUERY_FAILED}</p>;
}

export type Loaded<K, T> = { readonly key: K; readonly value: T };

export interface Load<K, T> {
  readonly loaded: Loaded<K, T> | null;
  readonly failed: boolean;
}

/**
 * Runs `load` whenever `deps` change and keeps the latest result with the tag it was loaded for.
 * A rejection is recorded against `key`, and `failed` turns on only while `key` is still the
 * current one, compared with Object.is. Panels that show a value under a request tag compare
 * `loaded.key` themselves. A null `load` keeps the current state untouched (a held read with
 * nothing to load). A result or rejection that arrives after cleanup changes nothing.
 */
export function useLoad<K, T>(key: K, load: (() => Promise<T>) | null, deps: DependencyList): Load<K, T> {
  const [loaded, setLoaded] = useState<Loaded<K, T> | null>(null);
  const [failure, setFailure] = useState<{ readonly key: K } | null>(null);
  useEffect(() => {
    if (load === null) return;
    let stale = false;
    setFailure(null);
    Promise.resolve()
      .then(load)
      .then(
        (value) => {
          if (!stale) setLoaded({ key, value });
        },
        () => {
          if (!stale) setFailure({ key });
        },
      );
    return () => {
      stale = true;
    };
  }, deps);
  return { loaded, failed: failure !== null && Object.is(failure.key, key) };
}

/** A text cell cut to fit, with the whole value on hover, so the number columns stay in view. */
export function TextCell(props: { value: unknown }) {
  const text = display(props.value);
  const short = shorten(text);
  return <td title={short === text ? undefined : text}>{short}</td>;
}

/** The engine's match label, with a partial match said the way a first-time reader follows it. */
export function matchLabel(config: BridgeConfig, level: number): string {
  if (level > 0 && level < config.levels.length && config.newAndDiscontinued !== "full") {
    return `Where the full configuration did not match, matched on ${config.levels
      .slice(0, level)
      .map((l) => l.name)
      .join(" + ")}.`;
  }
  return coverageLabel(config, level);
}

export function Kpi(props: { label: string; value: string; note?: string }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{props.label}</div>
      <div className="kpi-value">{props.value}</div>
      {props.note && <div className="kpi-note">{props.note}</div>}
    </div>
  );
}

export function TableActions(props: { name: string; header: string[]; rows: () => unknown[][] }) {
  const rows = () => props.rows().map((row) => row.map(finiteOrBlank));
  return (
    <span className="actions">
      <CopyButton text={() => toExportTsv(props.header, rows())} />
      <button onClick={() => saveOnce(props.name, () => toExportCsv(props.header, rows()), "text/csv")}>CSV</button>
    </span>
  );
}

export function CopyButton(props: { text: () => string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(props.text());
          setState("copied");
          setTimeout(() => setState((current) => (current === "copied" ? "idle" : current)), 1500);
        } catch {
          setState("failed");
        }
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
    </button>
  );
}
