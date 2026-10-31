import { useEffect, useState } from "react";
import { trend, type Query, type TrendStep } from "../../engine.ts";
import { shareOfPrior, signedPercent, signedWhole } from "../format.ts";
import { trendPeriods } from "../periods.ts";
import { trendHeader } from "../report.ts";
import type { Run } from "../Results.tsx";
import { TextCell } from "./shared.tsx";

const MAX_TREND_PERIODS = 13;

export function Trend(props: { run: Run; query: (() => Promise<Query>) | null }) {
  const periods = trendPeriods(props.run.periods, MAX_TREND_PERIODS);
  const [steps, setSteps] = useState<TrendStep[] | null>(null);
  const live = props.query !== null;
  useEffect(() => {
    if (periods.length < 3) return;
    const run = props.query;
    if (run === null) return;
    let stale = false;
    run()
      .then((query) => trend(query, props.run.config, periods))
      .then((result) => !stale && setSteps(result));
    return () => {
      stale = true;
    };
  }, [props.run, live]);
  if (periods.length < 3) {
    return (
      <p className="hint">
        The trend needs three or more periods. With a date column, compare by quarter or month to see one bridge per
        period.
      </p>
    );
  }
  if (!steps) {
    // A held read has no query to finish, so its sentence would never clear.
    if (!live) return null;
    return <p className="hint">Calculating a bridge for each pair of periods…</p>;
  }
  const widest = Math.max(...steps.map((s) => Math.abs(shareOfPrior(s.price, s.priorSales))), 0.0001);
  const header = trendHeader(props.run.config);
  return (
    <div>
      <table className="dense distribution">
        <thead>
          <tr>
            {header.map((column) => (
              <th key={column.label} className={column.num ? "num" : ""}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => (
            <tr key={s.current}>
              <TextCell value={`${s.prior} to ${s.current}`} />
              <td className="num strong">{signedWhole(s.currentSales - s.priorSales)}</td>
              <td className="num">{signedWhole(s.volume)}</td>
              <td className="num">{signedWhole(s.mix)}</td>
              <td className="num">{signedWhole(s.price)}</td>
              {s.unitCost === undefined ? null : <td className="num">{signedWhole(s.unitCost)}</td>}
              <td className="num">{signedPercent(shareOfPrior(s.price, s.priorSales))}</td>
              <td className="bar-cell" style={{ width: "18%" }}>
                <span
                  className="bar"
                  style={{
                    width: `${(Math.abs(shareOfPrior(s.price, s.priorSales)) / widest) * 100}%`,
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
