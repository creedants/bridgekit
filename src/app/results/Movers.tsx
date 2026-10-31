import { useState } from "react";
import { cumulativeColumns, drill, measureName, type DrillFilter, type Query } from "../../engine.ts";
import { finiteOrBlank } from "../exportExcel.ts";
import { saveOnce, toExportCsv } from "../files.ts";
import { price, signedPercent, signedWhole, whole } from "../format.ts";
import { moverHeader, terms } from "../report.ts";
import type { Run } from "../Results.tsx";
import { QueryFailed, TableActions, TextCell, display, useLoad } from "./shared.tsx";

/** The export keeps its short column names; the table has room to spell these out. */
const FULL_HEAD: Record<string, string> = { "New config.": "New configurations", Discontinued: "Discontinued configurations" };

export function Movers(props: { run: Run; query: () => Promise<Query>; sortBy: string; onSortBy: (key: string) => void }) {
  const { config } = props.run;
  const t = terms(config);
  const levels = config.levels;
  const options = [
    ...levels.map((level) => ({ label: level.name, columns: level.columns })),
    ...(levels.length > 1 ? [{ label: "Full configuration", columns: cumulativeColumns(levels, levels.length) }] : []),
  ];
  const [groupBy, setGroupBy] = useState(0);
  const [filters, setFilters] = useState<DrillFilter[]>([]);
  const [search, setSearch] = useState("");
  // Rows are kept with the grouping they were fetched for, so the table never
  // renders one grouping's rows under another grouping's columns.
  // `request` names the grouping, filters and search the rows were found for, so "No rows match." waits for the
  // request made last.
  const request = JSON.stringify([groupBy, filters, search]);
  const { loaded, failed } = useLoad(
    request,
    () =>
      props
        .query()
        .then((query) => drill(query, config, { columns: options[groupBy].columns, filters, sortBy: props.sortBy, search, limit: 200 }))
        .then((rows) => ({ groupBy, rows })),
    [props.run, groupBy, filters, props.sortBy, search],
  );
  const [saveError, setSaveError] = useState("");
  const shown = loaded?.value;
  const rows = shown?.rows ?? [];
  const shownGroupBy = shown?.groupBy ?? 0;
  const group = options[shownGroupBy] ?? options[0];
  const canDrill = shownGroupBy < levels.length - 1;

  const downloadAll = () => {
    setSaveError("");
    saveOnce(
      "movers-all-rows.csv",
      async () => {
        const all = await drill(await props.query(), config, {
          columns: group.columns, filters, sortBy: props.sortBy, search, limit: 500_000,
        });
        return toExportCsv(header, all.map(exportRow).map((row) => row.map(finiteOrBlank)));
      },
      "text/csv",
    ).catch((e) => setSaveError(`Could not save every row: ${e instanceof Error ? e.message : String(e)}`));
  };
  const empty = emptyNote(rows, request, loaded?.key ?? null);

  const mixOf = (row: Record<string, unknown>) =>
    levels.reduce((sum, _, i) => sum + Number(row[`mix_${i + 1}`] ?? 0), 0);
  const header = [...group.columns, ...moverHeader(config)];
  const values = (row: Record<string, unknown>) => {
    const p0 = Number(row.s0) / Number(row.q0);
    const p1 = Number(row.s1) / Number(row.q1);
    return {
      s0: Number(row.s0) + Number(row.z0),
      s1: Number(row.s1) + Number(row.z1),
      change: Number(row.s1) + Number(row.z1) - Number(row.s0) - Number(row.z0),
      discontinued: Number(row.discontinued),
      noUnits: Number(row.no_units),
      volume: Number(row.volume),
      mix: mixOf(row),
      price: Number(row.price),
      newConfig: Number(row.new_config),
      p0,
      p1,
      priceChange: p1 / p0 - 1,
    };
  };

  const exportRow = (row: Record<string, unknown>) => {
    const v = values(row);
    return [...group.columns.map((c) => display(row[c])), v.s0, v.s1, v.change, v.volume, v.mix, v.price, v.newConfig, v.discontinued, v.noUnits, v.p0, v.p1, v.priceChange];
  };

  return (
    <div>
      <p className="hint">Movers: The products and attribute values that changed {measureName(config).toLowerCase()} the most.</p>
      <div className="toolbar">
        <label>
          Group by
          <select value={groupBy} onChange={(e) => setGroupBy(Number(e.target.value))}>
            {options.map((option, i) => <option key={option.label} value={i}>{option.label}</option>)}
          </select>
        </label>
        <label>
          Sort by
          <select value={props.sortBy} onChange={(e) => props.onSortBy(e.target.value)}>
            <option value="change">Change</option>
            <option value="volume">Volume</option>
            <option value="mix">Mix</option>
            <option value="price">{t.priceEffect}</option>
            <option value="new_config">New configurations</option>
            <option value="discontinued">Discontinued configurations</option>
            <option value="no_units">Sales with no units</option>
          </select>
        </label>
        {filters.map((filter) => (
          <span className="chip" key={filter.column}>
            {filter.column}: {display(filter.value)}
            <button
              aria-label={`Remove filter on ${filter.column}`}
              onClick={() => setFilters(filters.filter((f) => f.column !== filter.column))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="search"
          placeholder={`Find ${group.label.toLowerCase()}`}
          aria-label="Find rows"
          style={{ width: 160 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <TableActions name="movers.csv" header={header} rows={() => rows.map(exportRow)} />
        <button onClick={downloadAll} title="Every row that matches, not only the 200 shown">All rows</button>
        {saveError && <p className="error" role="alert">{saveError}</p>}
      </div>
      {failed ? <QueryFailed /> : (
        <div className="scroll">
          <table className="dense">
            <thead>
              <tr>
                {header.map((h, i) => (
                  <th key={h} className={i >= group.columns.length ? "num" : ""}>{FULL_HEAD[h] ?? h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const v = values(row);
                return (
                  <tr
                    key={group.columns.map((c) => display(row[c])).join("|")}
                    className={canDrill ? "clickable" : ""}
                    title={canDrill ? `Show ${levels[shownGroupBy + 1].name} within this row` : undefined}
                    tabIndex={canDrill ? 0 : undefined}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.click();
                    }}
                    onClick={() => {
                      if (!canDrill) return;
                      const added = group.columns.map((column) => ({
                        column,
                        value: row[column] === null ? null : String(row[column]),
                      }));
                      setFilters([...filters.filter((f) => !group.columns.includes(f.column)), ...added]);
                      setGroupBy(shownGroupBy + 1);
                    }}
                  >
                    {group.columns.map((c) => <TextCell key={c} value={row[c]} />)}
                    <td className="num">{whole(v.s0)}</td>
                    <td className="num">{whole(v.s1)}</td>
                    <td className="num strong">{signedWhole(v.change)}</td>
                    <td className="num">{signedWhole(v.volume)}</td>
                    <td className="num">{signedWhole(v.mix)}</td>
                    <td className="num">{signedWhole(v.price)}</td>
                    <td className="num">{signedWhole(v.newConfig)}</td>
                    <td className="num">{signedWhole(v.discontinued)}</td>
                    <td className="num">{signedWhole(v.noUnits)}</td>
                    <td className="num">{price(v.p0)}</td>
                    <td className="num">{price(v.p1)}</td>
                    <td className="num">{signedPercent(v.priceChange)}</td>
                  </tr>
                );
              })}
              {empty && (
                <tr>
                  <td colSpan={header.length} className="hint">{empty}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">
        Top 200 by size. Each row’s effects add up to its change. {t.hintUnits}
        {canDrill && " Select a row to break it down by the next attribute."} {t.hintChange}
      </p>
    </div>
  );
}

/** Shown under a Movers search once the request asked for last has finished and found nothing. */
export function emptyNote(rows: readonly unknown[], wanted: string, fetchedFor: string | null): string | null {
  return rows.length === 0 && fetchedFor === wanted ? "No rows match." : null;
}
