import { sensitivity, type Query } from "../../engine.ts";
import { shorten } from "../files.ts";
import { matchedPercent, signedWhole, whole } from "../format.ts";
import type { Run } from "../Results.tsx";
import { QueryFailed, useLoad } from "./shared.tsx";

/**
 * The Setup check hint. `prices` holds the price effect of the full setup and
 * of each setup with one attribute left out.
 */
export function setupCheckHint(prices: number[], rowCount: number): string {
  if (rowCount === 1) return "With one attribute there is nothing to leave out.";
  return `Across these setups the price effect ranges from ${signedWhole(Math.min(...prices))} to ${signedWhole(Math.max(...prices))}. When leaving out an attribute moves price a lot, the bridge depends on that attribute. Keep it if it describes the product itself; a label that changed between periods can hide a real price change. An attribute that describes the customer, such as region or channel, can also move price a lot. It belongs last in the order, or it can be left out. One that barely moves price and lowers the match rate can be dropped.`;
}

export function SetupCheck(props: { run: Run; query: (() => Promise<Query>) | null }) {
  const live = props.query !== null;
  const run = props.query;
  const { loaded, failed } = useLoad(
    props.run,
    run === null ? null : () => run().then((query) => sensitivity(query, props.run.config)),
    [props.run, live],
  );
  if (failed) return <QueryFailed />;
  const rows = loaded?.value ?? null;
  if (!rows) {
    // A held read has no query to finish, so its sentence would never clear.
    if (!live) return null;
    return <p className="hint">Recalculating with each attribute left out…</p>;
  }
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
              <td title={[row.label, row.levels.map((l) => l.name).join(" › ")].filter(Boolean).join(" · ")}>{shorten(row.label)}</td>
              <td className="num">{signedWhole(row.price)}</td>
              <td className="num">{i === 0 ? "" : signedWhole(row.price - rows[0].price)}</td>
              <td className="num">{signedWhole(row.mix)}</td>
              <td className="num">{signedWhole(row.newAndDiscontinued)}</td>
              <td className="num">{matchedPercent(row.exactShare)}</td>
              <td className="num">{whole(row.cells)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">{setupCheckHint(prices, rows.length)}</p>
    </div>
  );
}
