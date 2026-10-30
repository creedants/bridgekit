import { useEffect, useState } from "react";
import { cumulativeColumns, priceGaps, type PriceGap, type Query } from "../../engine.ts";
import { percent, price, signedPercent, signedWhole, whole } from "../format.ts";
import { terms } from "../report.ts";
import type { Run } from "../Results.tsx";
import { Kpi, TableActions, TextCell, display } from "./shared.tsx";

export function PriceGaps(props: { run: Run; query: () => Promise<Query> }) {
  const { config } = props.run;
  const t = terms(config);
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
  const header = [...keys, "Units", t.measure, "Price", "Peer price", "Gap", "If at peer price"];
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
        <Kpi label={t.compared} value={whole(data.comparedSales)} note={`${config.current}, groups with 2+ ${last} values`} />
        <Kpi label="Priced below peers" value={whole(data.belowPeerSales)} note={percent(data.belowPeerSales / data.comparedSales) + " " + t.ofCompared} />
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
                {keys.map((c) => <TextCell key={c} value={row.keys[c]} />)}
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
