import { useEffect, useRef, useState } from "react";
import type { Level, Query } from "../engine.ts";
import { sameSuggestedLevels } from "./fileProblems.ts";
import { coverageNote, coverageSql, readCoverage, type PeriodCoverage } from "./periods.ts";
import { feeNote, feeRows, suggestAttributes, totalRowOffers, type FeeRows, type TotalRow } from "./profile.ts";
import {
  cleanLevels,
  effectiveName,
  isDate,
  isNumeric,
  MAX_LEVEL_NAME,
  measureColumns,
  measureNote,
  quote,
  refineGuess,
  TABLE,
  type Column,
  type Filter,
  type Grain,
  type Setup,
} from "./setup.ts";

/** Names that say how much one unit holds, so a shift in one can read as a price change. */
const SIZE_NAME = /volume|size|ml|litre|liter/i;

/** Count agreement lives here because this module loads eagerly and the lazily loaded results view can import it. */
export function agree(count: number, one: string, many = one + "s"): string {
  return count === 1 ? one : many;
}

export function distinctLabel(distinct: number | undefined): string {
  return distinct === undefined ? "" : ` (${distinct.toLocaleString("en-US")} ${agree(distinct, "value")})`;
}

export function SetupPanel(props: {
  columns: Column[];
  setup: Setup;
  periods: string[];
  prior: string;
  current: string;
  query: () => Promise<Query>;
  /** Columns that roll up into one another, broadest first. */
  rollups: string[][];
  /** Values that name a total row, which would count amounts twice. */
  totalRows: TotalRow[];
  onChange: (patch: Partial<Setup>) => void;
  onPrior: (value: string) => void;
  onCurrent: (value: string) => void;
}) {
  const { columns, setup, onChange } = props;
  const numeric = measureColumns(columns, setup);
  const periodType = columns.find((c) => c.name === setup.periodColumn)?.type ?? "";
  const used = new Set([
    setup.periodColumn,
    setup.unitsColumn,
    setup.salesColumn,
    setup.grossColumn,
    setup.costColumn,
    ...setup.levels.flatMap((l) => l.columns),
  ]);
  const free = columns.filter((c) => !used.has(c.name));
  const usedNames = new Set(
    [setup.periodColumn, setup.unitsColumn, setup.salesColumn, setup.grossColumn, setup.costColumn].filter(
      (name): name is string => typeof name === "string" && name !== "",
    ),
  );
  const distinctByName = new Map(columns.map((column) => [column.name, column.distinct ?? 0]));
  const suggested = suggestAttributes(columns, distinctByName, usedNames);
  // Names made from column headers are capped here, like typed ones. A level
  // with no column never reaches the bridge, the report or the export.
  const setLevels = (levels: Level[]) =>
    onChange({
      levels: cleanLevels(levels).map((level) => ({ ...level, name: level.name.slice(0, MAX_LEVEL_NAME) })),
    });
  const setFilters = (filters: Filter[]) => onChange({ filters });
  const factsSignature = columns
    .map((column) => `${column.name}:${column.facts?.sum ?? ""}:${column.facts?.first ?? ""}:${column.facts?.last ?? ""}:${column.facts?.months ?? ""}`)
    .join("|");
  // A value-based refinement lands once per set of column facts, so a later choice by the visitor stands.
  const refined = useRef("");
  useEffect(() => {
    if (refined.current === factsSignature) return;
    refined.current = factsSignature;
    const patch = refineGuess(setup, columns);
    if (Object.keys(patch).length > 0) onChange(patch);
  }, [factsSignature]);
  const [coverage, setCoverage] = useState<PeriodCoverage[]>([]);
  useEffect(() => {
    let stale = false;
    if (!isDate(periodType)) {
      setCoverage([]);
      return;
    }
    props
      .query()
      .then((query) =>
        query(
          coverageSql({
            table: TABLE,
            periodColumn: setup.periodColumn,
            grain: setup.grain,
            fiscalYearStart: setup.fiscalYearStart,
          }),
        ),
      )
      .then((rows) => !stale && setCoverage(readCoverage(rows)))
      .catch(() => !stale && setCoverage([]));
    return () => {
      stale = true;
    };
  }, [periodType, setup.periodColumn, setup.grain, setup.fiscalYearStart, factsSignature]);
  const partial = coverageNote(coverage, props.prior, props.current);
  const [fees, setFees] = useState<FeeRows | null>(null);
  const feeKey = `${factsSignature}|${setup.unitsColumn}|${setup.salesColumn}|${setup.levels[0]?.columns.join("+") ?? ""}`;
  useEffect(() => {
    let stale = false;
    props
      .query()
      .then((query) => feeRows(query, TABLE, setup))
      .then((found) => !stale && setFees(found))
      .catch(() => !stale && setFees(null));
    return () => {
      stale = true;
    };
  }, [feeKey]);
  const feesSentence = fees === null ? null : feeNote(fees);
  const measureHint = measureNote(columns, setup);
  const sizeColumn = columns.find(
    (column) => column.name !== setup.periodColumn && SIZE_NAME.test(column.name),
  );
  const suggestRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [asking, setAsking] = useState(false);
  const sameAsSuggested = sameSuggestedLevels(setup.levels, suggested);
  useEffect(() => setAsking(false), [suggested.join("|")]);
  useEffect(() => {
    if (asking) confirmRef.current?.focus();
  }, [asking]);
  useEffect(() => {
    if (!asking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setAsking(false);
      suggestRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [asking]);
  const useSuggestion = () => {
    setLevels(suggested.map((name) => ({ name, columns: [name] })));
    setAsking(false);
    suggestRef.current?.focus();
  };
  const keepMine = () => {
    setAsking(false);
    suggestRef.current?.focus();
  };
  const onSuggest = () => {
    if (sameAsSuggested) return;
    if (setup.levels.length === 0) useSuggestion();
    else setAsking(true);
  };
  const move = (from: number, to: number) => {
    const next = [...setup.levels];
    [next[from], next[to]] = [next[to], next[from]];
    setLevels(next);
  };

  return (
    <>
      <fieldset>
        <legend>Periods</legend>
        <label>
          Period column
          <select
            value={setup.periodColumn}
            onChange={(e) => {
              const column = columns.find((c) => c.name === e.target.value);
              const name = e.target.value;
              onChange({
                periodColumn: name,
                grain: column && isDate(column.type) ? "year" : "value",
                ...(setup.unitsColumn === name ? { unitsColumn: "" } : {}),
                ...(setup.salesColumn === name ? { salesColumn: "" } : {}),
              });
            }}
          >
            <option value="">Choose…</option>
            {columns.map((c) => <option key={c.name}>{c.name}</option>)}
          </select>
        </label>
        {isDate(periodType) && (
          <label>
            Compare by
            <select value={setup.grain} onChange={(e) => onChange({ grain: e.target.value as Grain })}>
              <option value="year">Year</option>
              <option value="ytd">Year to date</option>
              <option value="quarter">Quarter</option>
              <option value="month">Month</option>
            </select>
          </label>
        )}
        {isDate(periodType) &&
          (setup.grain === "year" || setup.grain === "ytd" || setup.grain === "quarter") && (
            <label>
              Year starts in
              <select
                value={setup.fiscalYearStart ?? 1}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  onChange({ fiscalYearStart: v === 1 ? undefined : v });
                }}
              >
                <option value={1}>January</option>
                <option value={2}>February</option>
                <option value={3}>March</option>
                <option value={4}>April</option>
                <option value={5}>May</option>
                <option value={6}>June</option>
                <option value={7}>July</option>
                <option value={8}>August</option>
                <option value={9}>September</option>
                <option value={10}>October</option>
                <option value={11}>November</option>
                <option value={12}>December</option>
              </select>
            </label>
          )}
        {isDate(periodType) &&
          (setup.grain === "year" || setup.grain === "ytd" || setup.grain === "quarter") &&
          setup.fiscalYearStart !== undefined &&
          setup.fiscalYearStart !== 1 && (
            <p className="hint">
              Each year is named after the year it ends in: July 2025 to June 2026 is FY2026.
            </p>
          )}
        {isDate(periodType) && setup.grain === "ytd" && (
          <p className="hint">
            Year to date: each year is cut at the month and day of the latest date in the file, so every year covers the
            same stretch.
          </p>
        )}
        <div className="pair">
          <label>
            Prior
            <select value={props.prior} onChange={(e) => props.onPrior(e.target.value)}>
              {props.periods.map((p) => <option key={p}>{p}</option>)}
            </select>
          </label>
          <label>
            Current
            <select value={props.current} onChange={(e) => props.onCurrent(e.target.value)}>
              {props.periods.map((p) => <option key={p}>{p}</option>)}
            </select>
          </label>
        </div>
        {partial && <p className="hint">{partial}</p>}
      </fieldset>

      <fieldset>
        <legend>Measures</legend>
        <div className="pair">
          <label>
            Units
            <select value={setup.unitsColumn} onChange={(e) => onChange({ unitsColumn: e.target.value })}>
              <option value="">Choose…</option>
              {numeric
                .filter((c) => c.name !== setup.salesColumn)
                .map((c) => <option key={c.name}>{c.name}</option>)}
            </select>
            <span className="hint">Quantity sold, such as pieces or cases.</span>
          </label>
          <label>
            Sales
            <select value={setup.salesColumn} onChange={(e) => onChange({ salesColumn: e.target.value })}>
              <option value="">Choose…</option>
              {numeric
                .filter((c) => c.name !== setup.unitsColumn)
                .map((c) => <option key={c.name}>{c.name}</option>)}
            </select>
            {measureHint && <span className="hint">{measureHint.sentence}</span>}
          </label>
        </div>
        <label>
          Gross sales (optional)
          <select value={setup.grossColumn ?? ""} onChange={(e) => onChange({ grossColumn: e.target.value || undefined })}>
            <option value="">None</option>
            {numeric.filter((c) => c.name !== setup.salesColumn).map((c) => <option key={c.name}>{c.name}</option>)}
          </select>
        </label>
        {setup.grossColumn && !setup.costColumn && <p className="hint">Price is split into list price and discounts.</p>}
        <label>
          Cost (optional)
          <select value={setup.costColumn ?? ""} onChange={(e) => onChange({ costColumn: e.target.value || undefined })}>
            <option value="">None</option>
            {numeric
              .filter((c) => c.name !== setup.salesColumn && c.name !== setup.unitsColumn)
              .map((c) => <option key={c.name}>{c.name}</option>)}
          </select>
        </label>
        {setup.costColumn && (
          <p className="hint">The bridge is on margin: sales minus cost. The rate effect is split into price and unit cost.</p>
        )}
      </fieldset>

      <fieldset>
        <legend>Attributes</legend>
        <p className="hint">
          Put the attribute you care about most at the top; each mix step is measured after the ones above it. One
          attribute gives a classic bridge: volume, one mix step and price.
        </p>
        <button
          className="action"
          ref={suggestRef}
          disabled={suggested.length === 0}
          onClick={onSuggest}
        >
          Suggest attributes
        </button>
        <p className="hint">
          Adds the columns that look like product attributes, fewest values first. Reorder them with the arrows.
        </p>
        {asking && (
          <div className="row">
            <span className="hint" id="suggest-confirm">
              Replace the attributes you chose with the suggested ones?
            </span>
            <button className="quiet" ref={confirmRef} aria-describedby="suggest-confirm" onClick={useSuggestion}>
              Replace
            </button>
            <button className="quiet" aria-describedby="suggest-confirm" onClick={keepMine}>
              Keep mine
            </button>
          </div>
        )}
        <ol className="levels">
          {setup.levels.map((level, i) => (
            <li key={level.columns.join("|")}>
              <div className="level-head">
                <span className="rank">{i + 1}</span>
                <NameInput
                  level={level}
                  onCommit={(name) =>
                    setLevels(
                      setup.levels.with(i, { ...level, name: name.trim() === "" ? effectiveName(level) : name }),
                    )
                  }
                />
                <button className="icon" aria-label="Move up" title="Move up" disabled={i === 0} onClick={() => move(i, i - 1)}>↑</button>
                <button className="icon" aria-label="Move down" title="Move down" disabled={i === setup.levels.length - 1} onClick={() => move(i, i + 1)}>↓</button>
                <button className="icon" aria-label="Remove attribute" title="Remove" onClick={() => setLevels(setup.levels.toSpliced(i, 1))}>×</button>
              </div>
              <div className="chips">
                {level.columns.map((column) => (
                  <span className="chip" key={column}>
                    {column}
                    {level.columns.length > 1 && (
                      <button
                        aria-label={`Remove ${column}`}
                        onClick={() =>
                          setLevels(setup.levels.with(i, { ...level, columns: level.columns.filter((c) => c !== column) }))
                        }
                      >
                        ×
                      </button>
                    )}
                  </span>
                ))}
                {free.length > 0 && (
                  <select
                    className="quiet"
                    aria-label="Combine another column into this attribute"
                    value=""
                    onChange={(e) => {
                      if (e.target.value === "") return;
                      setLevels(setup.levels.with(i, { ...level, columns: [...level.columns, e.target.value] }));
                    }}
                  >
                    <option value="">+ combine</option>
                    {free.map((c) => <option key={c.name}>{c.name}</option>)}
                  </select>
                )}
              </div>
            </li>
          ))}
        </ol>
        {free.length > 0 && setup.levels.length > 0 && (
          <p className="hint">+ combine joins another column into the same attribute, so the two count as one.</p>
        )}
        {free.length > 0 && (
          <select
            value=""
            aria-label="Add attribute"
            onChange={(e) => {
              if (e.target.value === "") return;
              setLevels([...setup.levels, { name: e.target.value, columns: [e.target.value] }]);
            }}
          >
            <option value="">Add attribute…</option>
            {free.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                  {distinctLabel(c.distinct)}
                </option>
              ))}
          </select>
        )}
        {props.rollups
          .filter((chain) => chain.some((column) => !used.has(column)))
          .map((chain) => (
            <div className="rollup" key={chain.join(">")}>
              <span className="hint">
                These columns nest: {chain[0]} is broader than {chain.at(-1)}.
              </span>
              {sizeColumn && !chain.includes(sizeColumn.name) && (
                <span className="hint">
                  "{sizeColumn.name}" is not in this roll-up, and a shift in it can show up as a price change.
                </span>
              )}
              <button
                className="quiet"
                onClick={() =>
                  setLevels([
                    ...setup.levels,
                    ...chain.filter((column) => !used.has(column)).map((column) => ({ name: column, columns: [column] })),
                  ])
                }
              >
                Add these
              </button>
            </div>
          ))}
        {totalRowOffers(props.totalRows, setup.filters).map((offer) => (
          <div className="rollup" key={offer.key}>
            <span className="hint">{offer.sentence}</span>
            <button className="quiet" onClick={() => setFilters(offer.filters)}>{offer.button}</button>
          </div>
        ))}
      </fieldset>
      {feesSentence && <p className="hint">{feesSentence}</p>}

      <fieldset>
        <legend>Options</legend>
        <label>
          New and discontinued
          <select
            value={setup.newAndDiscontinued ?? "difference"}
            onChange={(e) => onChange({ newAndDiscontinued: e.target.value as Setup["newAndDiscontinued"] })}
          >
            <option value="difference">Price difference only</option>
            <option value="full">Full sales</option>
          </select>
        </label>
        <p className="hint">
          {setup.newAndDiscontinued === "full"
            ? "New and discontinued configurations show their full sales. Volume, mix and price cover continuing configurations only."
            : "Units of new and discontinued configurations count in volume. Their lines show only the difference from the nearest comparable group."}
        </p>
      </fieldset>

      <fieldset>
        <legend>Filters</legend>
        {setup.filters.map((filter, i) => (
          <FilterEditor
            key={filter.column}
            filter={filter}
            query={props.query}
            onChange={(next) => setFilters(setup.filters.with(i, next))}
            onRemove={() => setFilters(setup.filters.toSpliced(i, 1))}
          />
        ))}
        <select
          value=""
          aria-label="Add filter"
          onChange={(e) => setFilters([...setup.filters, { column: e.target.value, mode: "include", values: [] }])}
        >
          <option value="">Add filter…</option>
          {columns
            .filter((c) => !isNumeric(c.type) && !setup.filters.some((f) => f.column === c.name))
            .map((c) => <option key={c.name}>{c.name}</option>)}
        </select>
      </fieldset>
    </>
  );
}

const MAX_FILTER_VALUES = 500;

/**
 * The attribute name, which keeps its own text while focused. An empty or blank
 * name falls back to the column's name when focus leaves, so a cleared name
 * can never reach the bridge, the report or the Excel export.
 */
function NameInput(props: { level: Level; onCommit: (name: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  const value = text ?? props.level.name;
  return (
    <input
      aria-label="Attribute name"
      value={value}
      maxLength={MAX_LEVEL_NAME}
      onChange={(e) => {
        const next = e.target.value.slice(0, MAX_LEVEL_NAME);
        setText(next);
        // An emptied name goes to the setup as the column's own name at once, so
        // the bridge, the report and the export never see a blank one.
        props.onCommit(next);
      }}
      onBlur={() => setText(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

function FilterEditor(props: {
  filter: Filter;
  query: () => Promise<Query>;
  onChange: (filter: Filter) => void;
  onRemove: () => void;
}) {
  const { filter } = props;
  const [values, setValues] = useState<string[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let stale = false;
    props
      .query()
      .then((query) =>
        query(
          `SELECT CAST(${quote(filter.column)} AS VARCHAR) AS v FROM ${quote(TABLE)}
           WHERE ${quote(filter.column)} IS NOT NULL
           GROUP BY 1 ORDER BY count(*) DESC LIMIT ${MAX_FILTER_VALUES}`,
        ),
      )
      .then((rows) => !stale && setValues(rows.map((row) => String(row.v))));
    return () => {
      stale = true;
    };
  }, [filter.column]);

  const selected = new Set(filter.values);
  const shown = values.filter((v) => v.toLowerCase().includes(search.toLowerCase()));
  const toggle = (value: string) =>
    props.onChange({
      ...filter,
      values: selected.has(value) ? filter.values.filter((v) => v !== value) : [...filter.values, value],
    });

  return (
    <div className="filter">
      <div className="level-head">
        <strong>{filter.column}</strong>
        <select
          className="quiet"
          aria-label="Filter mode"
          value={filter.mode}
          onChange={(e) => props.onChange({ ...filter, mode: e.target.value as Filter["mode"] })}
        >
          <option value="include">is one of</option>
          <option value="exclude">is not</option>
        </select>
        <button className="icon" aria-label="Remove filter" title="Remove" onClick={props.onRemove}>×</button>
      </div>
      {values.length > 8 && (
        <input placeholder="Search values" value={search} onChange={(e) => setSearch(e.target.value)} />
      )}
      <div className="values">
        {shown.map((value) => (
          <label key={value}>
            <input type="checkbox" checked={selected.has(value)} onChange={() => toggle(value)} />
            {value}
          </label>
        ))}
      </div>
      <p className="hint">
        {filter.values.length === 0
          ? "Nothing selected: this filter is off."
          : `${filter.values.length} selected`}
        {values.length === MAX_FILTER_VALUES && ` · showing the ${MAX_FILTER_VALUES} most common values`}
      </p>
    </div>
  );
}
