import { useState } from "react";
import { coverageLabel, type BridgeConfig } from "../../engine.ts";
import { finiteOrBlank } from "../exportExcel.ts";
import { saveOnce, shorten, toExportCsv, toExportTsv } from "../files.ts";

export const display = (value: unknown) => (value === null || value === undefined ? "(blank)" : String(value));

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
