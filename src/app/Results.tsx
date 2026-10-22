import { useEffect, useState } from "react";
import {
  coverageLabel,
  accountBridge,
  cumulativeColumns,
  drill,
  measureName,
  priceDistribution,
  priceGaps,
  priceRealization,
  sensitivity,
  tieOutLines,
  trend,
  unmatched,
  type BridgeConfig,
  type BridgeResult,
  type DataCheck,
  type TieOut,
  type AccountGroup,
  type Alternative,
  type DrillFilter,
  type PriceBucket,
  type PriceGap,
  type Realization,
  type TrendStep,
  type Query,
} from "../engine.ts";
import { commentary } from "../commentary.ts";
import { summarize, type BridgeSummary } from "../summary.ts";
import { download, toExportCsv, toExportTsv } from "./files.ts";
import { percent, price, signedPercent, signedWhole, whole } from "./format.ts";
import { decimalCommaNote } from "./numbers.ts";
import { trendPeriods } from "./periods.ts";
import { TABLE } from "./setup.ts";
import { useCommentaryOffer } from "./useConfig.ts";
import { buildReport, moverHeader, terms } from "./report.ts";
import { SmallBridges } from "./SmallBridges.tsx";
import { Waterfall } from "./Waterfall.tsx";

export interface Run {
  /** Text columns of the loaded file, for views that group by any column. */
  textColumns: string[];
  /** Every period in the loaded window, oldest first, for the trend view. */
  periods: string[];
  /** Human-readable lines describing the setup, for exports. */
  description: string[];
  config: BridgeConfig;
  result: BridgeResult;
  check: DataCheck;
  /** Money on the file and after the filters, in whole dollars, for the tie-out on the Data check tab. */
  tieOut: TieOut;
  ms: number;
}

type Tab = "bridge" | "movers" | "accounts" | "price" | "gaps" | "trend" | "unmatched" | "setup" | "check";

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
  const mixCount = run.result.effects.filter((e) => e.key.startsWith("mix_")).length;
  // With many attributes the chart gets crowded, so mix starts combined.
  const [combineMix, setCombineMix] = useState(mixCount > 4);

  const change = result.currentSales - result.priorSales;
  const priceEffect = result.effects.filter((e) => e.key.startsWith("price")).reduce((sum, e) => sum + e.value, 0);
  const exact = result.coverage.find((c) => c.level === config.levels.length)?.share ?? 0;
  const warnings = checkWarnings(run);

  const tabs: { id: Tab; label: string }[] = [
    { id: "bridge", label: "Bridge" },
    { id: "movers", label: "Movers" },
    { id: "accounts", label: "Accounts" },
    { id: "price", label: "Price changes" },
    { id: "gaps", label: "Price gaps" },
    { id: "trend", label: "Trend" },
    { id: "unmatched", label: "Unmatched" },
    { id: "setup", label: "Setup check" },
    { id: "check", label: warnings.length ? `Data check (${warnings.length})` : "Data check" },
  ];

  return (
    <>
      <div className="kpis">
        <Kpi label={`${measureName(config)} ${config.prior}`} value={whole(result.priorSales)} />
        <Kpi label={`${measureName(config)} ${config.current}`} value={whole(result.currentSales)} />
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
        <>
          <div className="bridge">
            <Waterfall
              result={combineMix ? withCombinedMix(result) : result}
              controls={
                mixCount > 1 && (
                  <label className="check">
                    <input type="checkbox" checked={combineMix} onChange={(e) => setCombineMix(e.target.checked)} />
                    Combine mix
                  </label>
                )
              }
              priorLabel={String(config.prior)}
              currentLabel={String(config.current)}
              footer={<Summary run={run} result={result} query={props.query} />}
              onSelect={(key) => {
                setSortBy(key.startsWith("mix_") ? "mix" : key.startsWith("price") || key === "cost_rate" ? "price" : key);
                setTab("movers");
              }}
            />
            <div>
              <table>
                <thead>
                  <tr><th>Bridge</th><th className="num">Amount</th><th className="num">% of prior</th></tr>
                </thead>
                <tbody>
                  <tr className="total"><td>{measureName(config)} {config.prior}</td><td className="num">{whole(result.priorSales)}</td><td /></tr>
                  {result.effects.map((e) => (
                    <tr key={e.key}>
                      <td>{e.label}</td>
                      <td className="num">{signedWhole(e.value)}</td>
                      <td className="num">{signedPercent(e.value / result.priorSales)}</td>
                    </tr>
                  ))}
                  <tr className="total"><td>{measureName(config)} {config.current}</td><td className="num">{whole(result.currentSales)}</td><td /></tr>
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
          <SmallBridges run={run} query={props.query} />
        </>
      )}
      {tab === "accounts" && <Accounts run={run} query={props.query} />}
      {tab === "gaps" && <PriceGaps run={run} query={props.query} />}
      {tab === "trend" && <Trend run={run} query={props.query} />}
      {tab === "setup" && <SetupCheck run={run} query={props.query} />}
      {tab === "price" && <PriceChanges run={run} query={props.query} />}
      {tab === "movers" && <Movers run={run} query={props.query} sortBy={sortBy} onSortBy={setSortBy} />}
      {tab === "unmatched" && <Unmatched run={run} query={props.query} />}
      {tab === "check" && <Check run={run} warnings={warnings} query={props.query} />}
    </>
  );
}

function Summary(props: { run: Run; result: Run["result"]; query: () => Promise<Query> }) {
  const paragraphs = commentary(props.result, props.run.config);
  const [copied, setCopied] = useState(false);
  const downloadReport = async () => {
    const { config } = props.run;
    const first = config.levels[0];
    const query = await props.query();
    const rows = await drill(query, config, { columns: first.columns, limit: 15 });
    const accountColumn = props.run.textColumns.find((c) => /customer|account|client|parent|sold.?to|buyer/i.test(c));
    const canvas = document.querySelector<HTMLCanvasElement>(".waterfall canvas");
    const html = buildReport({
      config,
      result: props.result,
      chartUrl: canvas?.toDataURL("image/png"),
      description: props.run.description,
      movers: { label: first.name, rows, columns: first.columns },
      priceBands: (await priceDistribution(query, config)).buckets,
      accounts: accountColumn
        ? { column: accountColumn, groups: await accountBridge(query, config, accountColumn) }
        : undefined,
    });
    download(`bridge-${config.prior}-to-${config.current}.html`, html, "text/html");
  };
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
          <button onClick={downloadReport}>Download report</button>
        </span>
      </div>
      {paragraphs.map((p) => <p key={p}>{p}</p>)}
      <p className="hint">Written from fixed sentence patterns, so the same bridge always gives the same text.</p>
      <AiOffer summary={summarize(props.result, props.run.config)} />
    </div>
  );
}

/**
 * A signed-in person with no Pro plan read sees the heading and the hint with
 * no button; the full panel, with the button, needs a plan read as Pro. The
 * offer comes from the calls the Workspace panel already makes, so the
 * decision adds no request to any /api/ path.
 */
function AiOffer(props: { summary: BridgeSummary }) {
  const offer = useCommentaryOffer();
  if (offer === "hidden") return null;
  return <AiCommentary key={JSON.stringify(props.summary)} summary={props.summary} offer={offer} />;
}

/**
 * Opt-in: nothing is sent until the user presses the button, and what is sent
 * is the summary shown in the panel, which holds totals and names only.
 * "hint" shows the explanation with no button, for a signed-in person without
 * Pro; "button" shows today's panel.
 */
function AiCommentary(props: { summary: BridgeSummary; offer: "hint" | "button" }) {
  const [state, setState] = useState<
    { status: "idle" } | { status: "busy" } | { status: "done"; paragraphs: string[] } | { status: "error"; message: string }
  >({ status: "idle" });
  const [copied, setCopied] = useState(false);
  const write = async () => {
    setState({ status: "busy" });
    try {
      const response = await fetch("/api/commentary", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ summary: props.summary }),
      });
      const body = (await response.json().catch(() => ({}))) as { paragraphs?: string[]; error?: string };
      if (!response.ok || !body.paragraphs) throw new Error(body.error ?? `The server returned ${response.status}.`);
      setState({ status: "done", paragraphs: body.paragraphs });
    } catch (e) {
      setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <div className="ai">
      <div className="toolbar">
        <h3>AI commentary (optional)</h3>
        {props.offer === "button" && state.status === "done" && (
          <span className="actions">
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(state.paragraphs.join("\n\n"));
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </span>
        )}
      </div>
      {props.offer === "hint" ? (
        <p className="hint">A longer commentary written by Anthropic&rsquo;s Claude.</p>
      ) : state.status === "done" ? (
        <>
          {state.paragraphs.map((p) => <p key={p}>{p}</p>)}
          <p className="hint">Written by an AI model (Anthropic&rsquo;s Claude). Check each figure against the bridge before you use it.</p>
        </>
      ) : (
        <>
          <p className="hint">
            A longer commentary written by Anthropic&rsquo;s Claude. Pressing the button sends the bridge totals below to
            Bridgekit&rsquo;s server, which passes them to Anthropic. No rows are sent, and no values from your data such as
            customer or product names. Nothing is sent until you press it.
          </p>
          <details>
            <summary>Show exactly what is sent</summary>
            <pre>{JSON.stringify(props.summary, null, 2)}</pre>
          </details>
          <p className="row">
            <button onClick={write} disabled={state.status === "busy"}>
              {state.status === "busy" ? "Writing…" : "Send totals and write commentary"}
            </button>
          </p>
          {state.status === "error" && <p className="error">{state.message}</p>}
        </>
      )}
    </div>
  );
}

const ACCOUNT_LABELS: Record<AccountGroup["status"], string> = {
  new: "New",
  lost: "Lost",
  growing: "Growing",
  shrinking: "Shrinking",
};

function Accounts(props: { run: Run; query: () => Promise<Query> }) {
  const { config, textColumns } = props.run;
  const guess =
    textColumns.find((c) => /customer|account|client|parent|sold.?to|buyer/i.test(c)) ?? textColumns[0] ?? "";
  const [column, setColumn] = useState(guess);
  const [groups, setGroups] = useState<AccountGroup[] | null>(null);
  useEffect(() => {
    if (!column) return;
    let stale = false;
    props
      .query()
      .then((query) => accountBridge(query, config, column))
      .then((result) => !stale && setGroups(result));
    return () => {
      stale = true;
    };
  }, [props.run, column]);
  if (!column) return <p className="hint">This view needs a text column such as customer.</p>;
  if (!groups) return null;
  const by = Object.fromEntries(groups.map((g) => [g.status, g])) as Record<AccountGroup["status"], AccountGroup>;
  const existingPrior = by.lost.prior + by.growing.prior + by.shrinking.prior;
  const measure = measureName(config).toLowerCase();
  return (
    <div>
      <div className="toolbar">
        <label>
          Account column
          <select value={column} onChange={(e) => setColumn(e.target.value)}>
            {textColumns.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <span className="hint">
          Any column works: customer, region, sales rep. It does not have to be an attribute of the bridge.
        </span>
      </div>
      <div className="kpis" style={{ marginBottom: 12 }}>
        {groups.map((g) => (
          <Kpi key={g.status} label={ACCOUNT_LABELS[g.status]} value={signedWhole(g.change)} note={`${whole(g.count)} ${column} values`} />
        ))}
        <Kpi
          label="Net retention"
          value={percent((by.growing.current + by.shrinking.current) / existingPrior)}
          note={`current ${measure} from prior accounts`}
        />
        <Kpi
          label="Gross retention"
          value={percent((existingPrior - by.lost.prior + by.shrinking.change) / existingPrior)}
          note="before growth and new accounts"
        />
      </div>
      <div className="account-grid">
        {groups.map((g) => (
          <div key={g.status}>
            <h3>{ACCOUNT_LABELS[g.status]}: largest {g.top.length}</h3>
            <table className="dense">
              <thead>
                <tr><th>{column}</th><th className="num">Prior</th><th className="num">Current</th><th className="num">Change</th></tr>
              </thead>
              <tbody>
                {g.top.map((a) => (
                  <tr key={a.name ?? "(blank)"}>
                    <td>{display(a.name)}</td>
                    <td className="num">{whole(a.prior)}</td>
                    <td className="num">{whole(a.current)}</td>
                    <td className="num strong">{signedWhole(a.change)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
      <p className="hint">
        New means no {measure} in {String(config.prior)}; lost means none in {String(config.current)}. The four groups
        add up to the total change, including rows with no units.
      </p>
    </div>
  );
}

const MAX_TREND_PERIODS = 13;

function Trend(props: { run: Run; query: () => Promise<Query> }) {
  const periods = trendPeriods(props.run.periods, MAX_TREND_PERIODS);
  const [steps, setSteps] = useState<TrendStep[] | null>(null);
  useEffect(() => {
    if (periods.length < 3) return;
    let stale = false;
    props
      .query()
      .then((query) => trend(query, props.run.config, periods))
      .then((result) => !stale && setSteps(result));
    return () => {
      stale = true;
    };
  }, [props.run]);
  if (periods.length < 3) {
    return (
      <p className="hint">
        The trend needs three or more periods. With a date column, compare by quarter or month to see one bridge per
        period.
      </p>
    );
  }
  if (!steps) return <p className="hint">Calculating a bridge for each pair of periods…</p>;
  const widest = Math.max(...steps.map((s) => Math.abs(s.price / s.priorSales)), 0.0001);
  return (
    <div>
      <table className="dense distribution">
        <thead>
          <tr>
            <th>Periods</th>
            <th className="num">Change</th>
            <th className="num">Volume</th>
            <th className="num">Mix</th>
            <th className="num">Price</th>
            <th className="num">Price, % of prior</th>
            <th>Price effect</th>
            <th className="num">New and discontinued</th>
            <th className="num">No units</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => (
            <tr key={s.current}>
              <td>{s.prior} to {s.current}</td>
              <td className="num strong">{signedWhole(s.currentSales - s.priorSales)}</td>
              <td className="num">{signedWhole(s.volume)}</td>
              <td className="num">{signedWhole(s.mix)}</td>
              <td className="num">{signedWhole(s.price)}</td>
              <td className="num">{signedPercent(s.price / s.priorSales)}</td>
              <td className="bar-cell" style={{ width: "18%" }}>
                <span
                  className="bar"
                  style={{
                    width: `${(Math.abs(s.price / s.priorSales) / widest) * 100}%`,
                    background: s.price >= 0 ? "var(--up)" : "var(--down)",
                  }}
                />
              </td>
              <td className="num">{signedWhole(s.newAndDiscontinued)}</td>
              <td className="num">{signedWhole(s.noUnits)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        One bridge for each pair of consecutive periods, using the same setup
        {props.run.periods.length > MAX_TREND_PERIODS ? `; the latest ${MAX_TREND_PERIODS} periods are shown` : ""}.
        Consecutive periods can carry seasonality, which shows up as volume and mix.
      </p>
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
      <RealizationTable run={props.run} query={props.query} overall={data.averageChange} />
    </div>
  );
}

function RealizationTable(props: { run: Run; query: () => Promise<Query>; overall: number }) {
  const levels = props.run.config.levels;
  const [groupBy, setGroupBy] = useState(0);
  const [target, setTarget] = useState("");
  const [data, setData] = useState<{ groupBy: number; rows: Realization[] }>({ groupBy: 0, rows: [] });
  useEffect(() => {
    let stale = false;
    props
      .query()
      .then((query) => priceRealization(query, props.run.config, levels[groupBy].columns))
      .then((rows) => !stale && setData({ groupBy, rows }));
    return () => {
      stale = true;
    };
  }, [props.run, groupBy]);
  const columns = levels[data.groupBy].columns;
  const planned = Number(target) / 100;
  const hasTarget = target.trim() !== "" && Number.isFinite(planned) && planned !== 0;
  const againstPlan = (row: Realization) => (row.change - planned) * (row.matchedSales - row.priceEffect);
  const header = [...columns, "Matched sales", "Price effect", "Realized change", ...(hasTarget ? ["Realization", "Against plan"] : [])];
  const cells = (row: Realization) => [
    ...columns.map((c) => display(row.keys[c])),
    row.matchedSales,
    row.priceEffect,
    row.change,
    ...(hasTarget ? [row.change / planned, againstPlan(row)] : []),
  ];
  return (
    <div style={{ marginTop: 20 }}>
      <h3>Did the increase stick?</h3>
      <div className="toolbar">
        <label>
          Planned increase %
          <input
            style={{ width: 70 }}
            inputMode="decimal"
            placeholder="e.g. 4"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </label>
        <label>
          By
          <select value={groupBy} onChange={(e) => setGroupBy(Number(e.target.value))}>
            {levels.map((level, i) => <option key={level.name} value={i}>{level.name}</option>)}
          </select>
        </label>
        {hasTarget && (
          <span className="hint" style={{ flex: "none", minWidth: 0 }}>
            Overall: {signedPercent(props.overall)} realized against {signedPercent(planned)} planned, or{" "}
            {percent(props.overall / planned)} of plan.
          </span>
        )}
        <TableActions name="price-realization.csv" header={header} rows={() => data.rows.map(cells)} />
      </div>
      <div className="scroll">
        <table className="dense">
          <thead>
            <tr>{header.map((h, i) => <th key={h} className={i >= columns.length ? "num" : ""}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={columns.map((c) => display(row.keys[c])).join("|")}>
                {columns.map((c) => <td key={c}>{display(row.keys[c])}</td>)}
                <td className="num">{whole(row.matchedSales)}</td>
                <td className="num">{signedWhole(row.priceEffect)}</td>
                <td className="num">{signedPercent(row.change)}</td>
                {hasTarget && <td className="num">{percent(row.change / planned)}</td>}
                {hasTarget && <td className="num">{signedWhole(againstPlan(row))}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">
        Realized change is the like-for-like price effect over what this period’s volume would have cost at prior
        prices. {hasTarget && "Against plan is the sales above or below what the planned increase would have delivered. "}
        Largest 200 groups by matched sales.
      </p>
    </div>
  );
}

function PriceGaps(props: { run: Run; query: () => Promise<Query> }) {
  const { config } = props.run;
  const k = config.levels.length;
  const [data, setData] = useState<Awaited<ReturnType<typeof priceGaps>> | null>(null);
  useEffect(() => {
    let stale = false;
    props
      .query()
      .then((query) => priceGaps(query, config))
      .then((result) => !stale && setData(result));
    return () => {
      stale = true;
    };
  }, [props.run]);
  if (k < 2) {
    return <p className="hint">Price gaps need two or more attributes. Put the one to compare, usually customer, last.</p>;
  }
  if (!data) return null;
  const last = config.levels[k - 1].name;
  const peers = config.levels.slice(0, k - 1).map((l) => l.name).join(" + ");
  const keys = cumulativeColumns(config.levels, k);
  const header = [...keys, "Units", "Sales", "Price", "Peer price", "Gap", "If at peer price"];
  const cells = (row: PriceGap) => [
    ...keys.map((c) => display(row.keys[c])),
    row.units,
    row.sales,
    row.price,
    row.peerPrice,
    row.price / row.peerPrice - 1,
    row.opportunity,
  ];
  return (
    <div>
      <div className="kpis" style={{ marginBottom: 12 }}>
        <Kpi label="Sales compared" value={whole(data.comparedSales)} note={`${config.current}, groups with 2+ ${last} values`} />
        <Kpi label="Priced below peers" value={whole(data.belowPeerSales)} note={percent(data.belowPeerSales / data.comparedSales) + " of sales compared"} />
        <Kpi label="If raised to peer average" value={signedWhole(data.totalOpportunity)} note="upper bound, not a forecast" />
      </div>
      <div className="toolbar">
        <span className="hint">
          Each {last} is compared with the average price for the same {peers} in {String(config.current)}. Largest gaps
          first.
        </span>
        <TableActions name="price-gaps.csv" header={header} rows={() => data.rows.map(cells)} />
      </div>
      <div className="scroll">
        <table className="dense">
          <thead>
            <tr>{header.map((h, i) => <th key={h} className={i >= keys.length ? "num" : ""}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={keys.map((c) => display(row.keys[c])).join("|")}>
                {keys.map((c) => <td key={c}>{display(row.keys[c])}</td>)}
                <td className="num">{whole(row.units)}</td>
                <td className="num">{whole(row.sales)}</td>
                <td className="num">{price(row.price)}</td>
                <td className="num">{price(row.peerPrice)}</td>
                <td className="num">{signedPercent(row.price / row.peerPrice - 1)}</td>
                <td className="num strong">{signedWhole(row.opportunity)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">
        A gap can have good reasons, such as volume tiers or contract terms. Treat the list as places to look, and the
        total as a ceiling.
      </p>
    </div>
  );
}

/** The same bridge with the per-attribute mix lines added into one. */
function withCombinedMix(result: Run["result"]): Run["result"] {
  const mixes = result.effects.filter((e) => e.key.startsWith("mix_"));
  if (mixes.length < 2) return result;
  const combined = { key: "mix_all", label: "Mix", value: mixes.reduce((sum, e) => sum + e.value, 0) };
  const first = result.effects.indexOf(mixes[0]);
  return {
    ...result,
    effects: [...result.effects.slice(0, first), combined, ...result.effects.slice(first).filter((e) => !e.key.startsWith("mix_"))],
  };
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
          await navigator.clipboard.writeText(toExportTsv(props.header, props.rows()));
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <button onClick={() => download(props.name, toExportCsv(props.header, props.rows()), "text/csv")}>CSV</button>
    </span>
  );
}

function Movers(props: { run: Run; query: () => Promise<Query>; sortBy: string; onSortBy: (key: string) => void }) {
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
  const [data, setData] = useState<{ groupBy: number; rows: Record<string, unknown>[] }>({ groupBy: 0, rows: [] });
  const rows = data.rows;
  const group = options[data.groupBy] ?? options[0];
  const canDrill = data.groupBy < levels.length - 1;

  useEffect(() => {
    let stale = false;
    props
      .query()
      .then((query) => drill(query, config, { columns: options[groupBy].columns, filters, sortBy: props.sortBy, search, limit: 200 }))
      .then((result) => !stale && setData({ groupBy, rows: result }));
    return () => {
      stale = true;
    };
  }, [props.run, groupBy, filters, props.sortBy, search]);

  const downloadAll = async () => {
    const all = await drill(await props.query(), config, {
      columns: group.columns, filters, sortBy: props.sortBy, search, limit: 500_000,
    });
    download("movers.csv", toExportCsv(header, all.map(exportRow)), "text/csv");
  };

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
        Top 200 by size. Each row’s effects add up to its change. {t.hintUnits}
        {canDrill && " Click a row to break it down by the next attribute."} {t.hintChange}
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

function Check(props: { run: Run; warnings: string[]; query: () => Promise<Query> }) {
  const { check, config, ms, tieOut: money } = props.run;
  const tieOut = tieOutLines(config, money, props.run.result);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    setNote(null);
    props
      .query()
      .then((query) => decimalCommaNote(query, TABLE))
      .then((sentence) => {
        if (!stale) setNote(sentence);
      })
      .catch(() => {
        if (!stale) setNote(null);
      });
    return () => {
      stale = true;
    };
  }, [props.run]);
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
      <h3>Money tie-out</h3>
      <table className="narrow tieout">
        <tbody>
          {tieOut.map((line) => (
            <tr key={line.label}><td>{line.label}</td><td className="num">{Number.isFinite(line.value) ? whole(line.value) : ""}</td></tr>
          ))}
        </tbody>
      </table>
      {props.warnings.length === 0 ? (
        <p className="ok">No issues found in the rows used.</p>
      ) : (
        <ul className="warnings">{props.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
      )}
      {note ? <p className="hint">{note}</p> : null}
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
