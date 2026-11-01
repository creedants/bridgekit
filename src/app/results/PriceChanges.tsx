import { useState } from "react";
import { priceDistribution, priceRealization, type Query, type Realization } from "../../engine.ts";
import { parsePlannedIncrease } from "../files.ts";
import { percent, signedPercent, signedWhole, whole } from "../format.ts";
import { terms } from "../report.ts";
import type { Run } from "../Results.tsx";
import { Kpi, QueryFailed, TableActions, TextCell, display, useLoad } from "./shared.tsx";

/**
 * What the price counts include. The margin bridge splits price into two steps, so its note says
 * which pair to read together.
 */
export const priceNote = (measure: string) => {
  const note = `Counts only exactly matched configurations with positive units in both periods and positive prior ${measure}, after each configuration's rows are added together. The Bridge price step can include other configurations.`;
  return measure === "margin" ? `${note} On a margin bridge, compare the combined Price and Unit cost steps.` : note;
};

export function PriceChanges(props: { run: Run; query: () => Promise<Query> }) {
  const { loaded, failed } = useLoad(
    props.run,
    () => props.query().then((query) => priceDistribution(query, props.run.config)),
    [props.run],
  );
  const data = loaded?.value ?? null;
  if (failed) return <QueryFailed />;
  if (!data) return null;
  const t = terms(props.run.config);
  const widest = Math.max(...data.buckets.map((b) => b.share), 0.0001);
  const moved = (from: number, to: number) => data.buckets.slice(from, to).reduce((sum, b) => sum + b.share, 0);
  return (
    <div>
      <div className="kpis" style={{ marginBottom: 12 }}>
        <Kpi label="Average price change" value={signedPercent(data.averageChange)} note="exactly matched configurations" />
        <Kpi label={t.priceUp} value={percent(moved(5, 9))} note="up more than 0.5%" />
        <Kpi label={t.priceFlat} value={percent(moved(4, 5))} note="within 0.5%" />
        <Kpi label={t.priceDown} value={percent(moved(0, 4))} note="down more than 0.5%" />
      </div>
      <table className="dense distribution">
        <thead>
          <tr>
            <th>Change in average price</th>
            <th>{t.matchedShare}</th>
            <th className="num">Share</th>
            <th className="num">{t.current}</th>
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
        Each configuration counted here is placed by how much its average price moved between the two periods.
        This shows how widely a price change landed, which the single price number in the bridge cannot.{" "}
        {priceNote(t.measure.toLowerCase())}
      </p>
      <RealizationTable run={props.run} query={props.query} overall={data.averageChange} />
    </div>
  );
}

function RealizationTable(props: { run: Run; query: () => Promise<Query>; overall: number }) {
  const levels = props.run.config.levels;
  const [groupBy, setGroupBy] = useState(0);
  const [target, setTarget] = useState("");
  const { loaded, failed } = useLoad(
    groupBy,
    () => props.query().then((query) => priceRealization(query, props.run.config, levels[groupBy].columns)),
    [props.run, groupBy],
  );
  const columns = levels[loaded?.key ?? 0].columns;
  const rows = loaded?.value ?? [];
  const t = terms(props.run.config);
  const plan = parsePlannedIncrease(target);
  const planned = typeof plan === "object" ? plan.value / 100 : 0;
  const hasTarget = planned !== 0;
  const againstPlan = (row: Realization) => (row.change - planned) * (row.matchedSales - row.priceEffect);
  const header = [...columns, t.matched, "Price effect", "Realized change", ...(hasTarget ? ["Realization", "Against plan"] : [])];
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
        {plan === "invalid" && (
          <span className="error" role="alert" style={{ flex: "none", minWidth: 0 }}>
            Enter a planned increase between -100% and 1000%.
          </span>
        )}
        {hasTarget && (
          <span className="hint" style={{ flex: "none", minWidth: 0 }}>
            Overall: {signedPercent(props.overall)} realized against {signedPercent(planned)} planned, or{" "}
            {percent(props.overall / planned)} of plan.
          </span>
        )}
        <TableActions name="price-realization.csv" header={header} rows={() => rows.map(cells)} />
      </div>
      {failed ? <QueryFailed /> : (
        <div className="scroll">
          <table className="dense">
            <thead>
              <tr>{header.map((h, i) => <th key={h} className={i >= columns.length ? "num" : ""}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={columns.map((c) => display(row.keys[c])).join("|")}>
                  {columns.map((c) => <TextCell key={c} value={row.keys[c]} />)}
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
      )}
      <p className="hint">
        Realized change is the like-for-like price effect over what this period’s volume would have cost at prior
        prices. {hasTarget && `${t.againstPlan} `}
        {t.largestGroups}
      </p>
    </div>
  );
}
