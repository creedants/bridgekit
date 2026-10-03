import { useEffect, useState } from "react";
import {
  coverageLabel,
  cumulativeColumns,
  drill,
  priceDistribution,
  sensitivity,
  unmatched,
  type BridgeConfig,
  type BridgeResult,
  type DataCheck,
  type Alternative,
  type DrillFilter,
  type PriceBucket,
  type Query,
} from "../engine.ts";
import { commentary } from "../commentary.ts";
import { download, toCsv, toTsv } from "./files.ts";
import { percent, price, signedPercent, signedWhole, whole } from "./format.ts";
import { Waterfall } from "./Waterfall.tsx";

export interface Run {
  config: BridgeConfig;
  result: BridgeResult;
  check: DataCheck;
  ms: number;
}

type Tab = "bridge" | "movers" | "price" | "unmatched" | "setup" | "check";

const display = (value: unknown) => (value === null || value === undefined ? "(blank)" : String(value));

export function Results(props: { run: Run; query: () => Promise<Query> }) {
  const { run } = props;
  const { config } = run;
  // A bridge line that only exists for some data is left out when it is exactly zero.
  const result = {
    ...run.result,
    effects: run.result.effects.filter((e) => e.key !== "no_units" || e.value !== 0),
  };
  const [tab, setTab] = useState<Tab>("bridge");
  const [sortBy, setSortBy] = useState("change");

  const change = result.currentSales - result.priorSales;
  const priceEffect = result.effects.filter((e) => e.key.startsWith("price")).reduce((sum, e) => sum + e.value, 0);
  const exact = result.coverage.find((c) => c.level === config.levels.length)?.share ?? 0;
  const warnings = checkWarnings(run);

  const tabs: { id: Tab; label: string }[] = [
    { id: "bridge", label: "Bridge" },
    { id: "movers", label: "Movers" },
    { id: "price", label: "Price changes" },
    { id: "unmatched", label: "Unmatched" },
    { id: "setup", label: "Setup check" },
    { id: "check", label: warnings.length ? `Data check (${warnings.length})` : "Data check" },
  ];

  return (
    <>
      <div className="kpis">
        <Kpi label={`Sales ${config.prior}`} value={whole(result.priorSales)} />
        <Kpi label={`Sales ${config.current}`} value={whole(result.currentSales)} />
        <Kpi label="Change" value={signedWhole(change)} note={signedPercent(change / result.priorSales)} />
        <Kpi label="Like-for-like price" value={signedWhole(priceEffect)} note={signedPercent(priceEffect / result.priorSales)} />
        <Kpi label="Matched exactly" value={percent(exact)} note="of current sales with units" />
      </div>

      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "bridge" && (
        <div className="bridge">
          <Waterfall
            result={result}
            priorLabel={String(config.prior)}
            currentLabel={String(config.current)}
            footer={<Summary run={run} result={result} />}
            onSelect={(key) => {
              setSortBy(key.startsWith("mix_") ? "mix" : key.startsWith("price") ? "price" : key);
              setTab("movers");
            }}
          />
          <div>
            <table>
              <thead>
                <tr><th>Bridge</th><th className="num">Amount</th><th className="num">% of prior</th></tr>
              </thead>
              <tbody>
                <tr className="total"><td>Sales {config.prior}</td><td className="num">{whole(result.priorSales)}</td><td /></tr>
                {result.effects.map((e) => (
                  <tr key={e.key}>
                    <td>{e.label}</td>
                    <td className="num">{signedWhole(e.value)}</td>
                    <td className="num">{signedPercent(e.value / result.priorSales)}</td>
                  </tr>
                ))}
                <tr className="total"><td>Sales {config.current}</td><td className="num">{whole(result.currentSales)}</td><td /></tr>
              </tbody>
            </table>
            <h3>How current sales were matched</h3>
            <table>
              <thead>
                <tr><th>Compared against</th><th className="num">Share</th><th className="num">Configurations</th></tr>
              </thead>
              <tbody>
                {result.coverage.map((c) => (
                  <tr key={c.level}>
                    <td>{c.label}</td>
                    <td className="num">{percent(c.share)}</td>
                    <td className="num">{whole(c.cells)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint">
              Only exact matches count as price. The rest is in “New configurations”; see the Unmatched tab. Shares are of current sales on rows with units.
            </p>
          </div>
        </div>
      )}
      {tab === "setup" && <SetupCheck run={run} query={props.query} />}
      {tab === "price" && <PriceChanges run={run} query={props.query} />}
      {tab === "movers" && <Movers run={run} query={props.query} sortBy={sortBy} onSortBy={setSortBy} />}
      {tab === "unmatched" && <Unmatched run={run} query={props.query} />}
      {tab === "check" && <Check run={run} warnings={warnings} />}
    </>
  );
}

function Summary(props: { run: Run; result: Run["result"] }) {
  const paragraphs = commentary(props.result, props.run.config);
  const [copied, setCopied] = useState(false);
  return (
    <div className="summary">
      <div className="toolbar">
        <h3>Summary</h3>
        <span className="actions">
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(paragraphs.join("\n\n"));
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </span>
      </div>
      {paragraphs.map((p) => <p key={p}>{p}</p>)}
      <p className="hint">Written from fixed sentence patterns, so the same bridge always gives the same text.</p>
    </div>
  );
}

function SetupCheck(props: { run: Run; query: () => Promise<Query> }) {
  const [rows, setRows] = useState<Alternative[] | null>(null);
  useEffect(() => {
    let stale = false;
    props
      .query()
      .then((query) => sensitivity(query, props.run.config))
      .then((result) => !stale && setRows(result));
    return () => {
      stale = true;
    };
  }, [props.run]);
  if (!rows) return <p className="hint">Recalculating with each attribute left out…</p>;
  const prices = rows.map((r) => r.price);
  return (
    <div>
      <table className="dense narrow-wide">
        <thead>
          <tr>
            <th>Attributes used</th>
            <th className="num">Price</th>
            <th className="num">vs your setup</th>
            <th className="num">Mix</th>
            <th className="num">New and discontinued</th>
            <th className="num">Matched exactly</th>
            <th className="num">Configurations</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.label} className={i === 0 ? "total" : ""}>
              <td title={row.levels.map((l) => l.name).join(" › ")}>{row.label}</td>
              <td className="num">{signedWhole(row.price)}</td>
              <td className="num">{i === 0 ? "" : signedWhole(row.price - rows[0].price)}</td>
              <td className="num">{signedWhole(row.mix)}</td>
              <td className="num">{signedWhole(row.newAndDiscontinued)}</td>
              <td className="num">{percent(row.exactShare)}</td>
              <td className="num">{whole(row.cells)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        {rows.length === 1
          ? "With one attribute there is nothing to leave out."
          : `Across these setups the price effect ranges from ${signedWhole(Math.min(...prices))} to ${signedWhole(Math.max(...prices))}. An attribute whose removal moves price a lot is one that carries real mix: keep it. One that barely moves price and lowers the match rate can be dropped.`}
      </p>
    </div>
  );
}

function PriceChanges(props: { run: Run; query: () => Promise<Query> }) {
  const [data, setData] = useState<{ buckets: PriceBucket[]; averageChange: number } | null>(null);
  useEffect(() => {
    let stale = false;
    props
      .query()
      .then((query) => priceDistribution(query, props.run.config))
      .then((result) => !stale && setData(result));
    return () => {
      stale = true;
    };
  }, [props.run]);
  if (!data) return null;
  const widest = Math.max(...data.buckets.map((b) => b.share), 0.0001);
  const moved = (from: number, to: number) => data.buckets.slice(from, to).reduce((sum, b) => sum + b.share, 0);
  return (
    <div>
      <div className="kpis" style={{ marginBottom: 12 }}>
        <Kpi label="Average price change" value={signedPercent(data.averageChange)} note="exactly matched configurations" />
        <Kpi label="Sales with a price increase" value={percent(moved(5, 9))} note="up more than 0.5%" />
        <Kpi label="Sales with no change" value={percent(moved(4, 5))} note="within 0.5%" />
        <Kpi label="Sales with a price decrease" value={percent(moved(0, 4))} note="down more than 0.5%" />
      </div>
      <table className="dense distribution">
        <thead>
          <tr>
            <th>Change in average price</th>
            <th>Share of matched sales</th>
            <th className="num">Share</th>
            <th className="num">Current sales</th>
            <th className="num">Price effect</th>
            <th className="num">Configurations</th>
          </tr>
        </thead>
        <tbody>
          {data.buckets.map((b, i) => (
            <tr key={b.label}>
              <td>{b.label}</td>
              <td className="bar-cell">
                <span
                  className="bar"
                  style={{
                    width: `${(b.share / widest) * 100}%`,
                    background: i < 4 ? "var(--down)" : i === 4 ? "var(--total)" : "var(--up)",
                  }}
                />
              </td>
              <td className="num">{percent(b.share)}</td>
              <td className="num">{whole(b.sales)}</td>
              <td className="num">{signedWhole(b.priceEffect)}</td>
              <td className="num">{whole(b.cells)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        Each exactly matched configuration is placed by how much its average price moved between the two periods.
        This shows how widely a price change landed, which the single price number in the bridge cannot.
      </p>
    </div>
  );
}

function Kpi(props: { label: string; value: string; note?: string }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{props.label}</div>
      <div className="kpi-value">{props.value}</div>
      {props.note && <div className="kpi-note">{props.note}</div>}
    </div>
  );
}

function TableActions(props: { name: string; header: string[]; rows: () => unknown[][] }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="actions">
      <button
        onClick={async () => {
          await navigator.clipboard.writeText(toTsv(props.header, props.rows()));
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <button onClick={() => download(props.name, toCsv(props.header, props.rows()), "text/csv")}>CSV</button>
    </span>
  );
}

function Movers(props: { run: Run; query: () => Promise<Query>; sortBy: string; onSortBy: (key: string) => void }) {
  const { config } = props.run;
  const levels = config.levels;
  const options = [
    ...levels.map((level) => ({ label: level.name, columns: level.columns })),
    ...(levels.length > 1 ? [{ label: "Full configuration", columns: cumulativeColumns(levels, levels.length) }] : []),
  ];
  const [groupBy, setGroupBy] = useState(0);
  const [filters, setFilters] = useState<DrillFilter[]>([]);
  // Rows are kept with the grouping they were fetched for, so the table never
  // renders one grouping's rows under another grouping's columns.
  const [data, setData] = useState<{ groupBy: number; rows: Record<string, unknown>[] }>({ groupBy: 0, rows: [] });
  const rows = data.rows;
  const group = options[data.groupBy] ?? options[0];
  const canDrill = data.groupBy < levels.length - 1;

  useEffect(() => {
    let stale = false;
    props
      .query()
      .then((query) => drill(query, config, { columns: options[groupBy].columns, filters, sortBy: props.sortBy, limit: 200 }))
      .then((result) => !stale && setData({ groupBy, rows: result }));
    return () => {
      stale = true;
    };
  }, [props.run, groupBy, filters, props.sortBy]);

  const mixOf = (row: Record<string, unknown>) =>
    levels.reduce((sum, _, i) => sum + Number(row[`mix_${i + 1}`] ?? 0), 0);
  const header = [...group.columns, "Prior sales", "Current sales", "Change", "Volume", "Mix", "Price", "New config.", "Discontinued", "No units", "Prior price", "Current price", "Price change"];
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

  return (
    <div>
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
            <option value="price">Price</option>
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
        <TableActions
          name="movers.csv"
          header={header}
          rows={() =>
            rows.map((row) => {
              const v = values(row);
              return [...group.columns.map((c) => display(row[c])), v.s0, v.s1, v.change, v.volume, v.mix, v.price, v.newConfig, v.discontinued, v.noUnits, v.p0, v.p1, v.priceChange];
            })
          }
        />
      </div>
      <div className="scroll">
        <table className="dense">
          <thead>
            <tr>
              {header.map((h, i) => <th key={h} className={i >= group.columns.length ? "num" : ""}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const v = values(row);
              return (
                <tr
                  key={group.columns.map((c) => display(row[c])).join("|")}
                  className={canDrill ? "clickable" : ""}
                  title={canDrill ? `Show ${levels[data.groupBy + 1].name} within this row` : undefined}
                  onClick={() => {
                    if (!canDrill) return;
                    const added = group.columns.map((column) => ({
                      column,
                      value: row[column] === null ? null : String(row[column]),
                    }));
                    setFilters([...filters.filter((f) => !group.columns.includes(f.column)), ...added]);
                    setGroupBy(data.groupBy + 1);
                  }}
                >
                  {group.columns.map((c) => <td key={c}>{display(row[c])}</td>)}
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
          </tbody>
        </table>
      </div>
      <p className="hint">
        Top 200 by size. Each row’s effects add up to its change. Prices exclude sales with no units.
        {canDrill && " Click a row to break it down by the next attribute."} Price change is the change in average
        price and includes mix inside the row.
      </p>
    </div>
  );
}

function Unmatched(props: { run: Run; query: () => Promise<Query> }) {
  const { config } = props.run;
  const keys = cumulativeColumns(config.levels, config.levels.length);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);

  useEffect(() => {
    let stale = false;
    props
      .query()
      .then((query) => unmatched(query, config, 200))
      .then((result) => !stale && setRows(result));
    return () => {
      stale = true;
    };
  }, [props.run]);

  const header = [...keys, "Units", "Sales", "Price", "Compared against", "Reference price", "Effect"];
  const cells = (row: Record<string, unknown>) => [
    ...keys.map((c) => display(row[c])),
    Number(row.q1),
    Number(row.s1),
    Number(row.s1) / Number(row.q1),
    coverageLabel(config, Number(row.match_level)),
    row.ref_price === null ? "" : Number(row.ref_price),
    Number(row.new_config),
  ];

  if (rows.length === 0) {
    return <p className="hint">Every current-period configuration had an exact match in the prior period.</p>;
  }
  return (
    <div>
      <div className="toolbar">
        <span className="hint">
          Current-period configurations with no exact prior match, largest first. Their difference from the reference
          price is the “New configurations” effect.
        </span>
        <TableActions name="unmatched.csv" header={header} rows={() => rows.map(cells)} />
      </div>
      <div className="scroll">
        <table className="dense">
          <thead>
            <tr>{header.map((h, i) => <th key={h} className={i >= keys.length && i !== keys.length + 3 ? "num" : ""}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={keys.map((c) => display(row[c])).join("|")}>
                {keys.map((c) => <td key={c}>{display(row[c])}</td>)}
                <td className="num">{whole(Number(row.q1))}</td>
                <td className="num">{whole(Number(row.s1))}</td>
                <td className="num">{price(Number(row.s1) / Number(row.q1))}</td>
                <td>{coverageLabel(config, Number(row.match_level))}</td>
                <td className="num">{row.ref_price === null ? "" : price(Number(row.ref_price))}</td>
                <td className="num">{signedWhole(Number(row.new_config))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function checkWarnings(run: Run): string[] {
  const { check, config, result } = run;
  const exact = result.coverage.find((c) => c.level === config.levels.length)?.share ?? 0;
  const warnings: string[] = [];
  if (check.blankMeasureRows > 0) {
    warnings.push(`${whole(check.blankMeasureRows)} rows have blank units or sales and count as zero.`);
  }
  if (check.negativeUnitRows > 0) {
    warnings.push(`${whole(check.negativeUnitRows)} rows have negative units (returns or credits). They are netted against sales of the same configuration.`);
  }
  if (check.zeroUnitSalesRows > 0) {
    warnings.push(`${whole(check.zeroUnitSalesRows)} rows have sales but zero units (rebates, credits or fees). They are bridged on their own line, “Sales with no units”, and kept out of price.`);
  }
  if (check.blankPeriodRows > 0) {
    warnings.push(`${whole(check.blankPeriodRows)} rows have a blank period and are ignored.`);
  }
  if (exact < 0.7) {
    warnings.push(`Only ${percent(exact)} of current sales matched an exact prior configuration. Consider fewer attributes, or check the Unmatched tab.`);
  }
  return warnings;
}

function Check(props: { run: Run; warnings: string[] }) {
  const { check, config, ms } = props.run;
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
    <div className="check">
      {props.warnings.length === 0 ? (
        <p className="ok">No issues found in the rows used.</p>
      ) : (
        <ul className="warnings">{props.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
      )}
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
