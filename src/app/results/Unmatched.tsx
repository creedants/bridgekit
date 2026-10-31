import { cumulativeColumns, unmatched, type Query } from "../../engine.ts";
import { price, signedWhole, whole } from "../format.ts";
import { terms } from "../report.ts";
import type { Run } from "../Results.tsx";
import { QueryFailed, TableActions, TextCell, display, matchLabel, useLoad } from "./shared.tsx";

export function Unmatched(props: { run: Run; query: () => Promise<Query> }) {
  const { config } = props.run;
  const t = terms(config);
  const keys = cumulativeColumns(config.levels, config.levels.length);
  const { loaded, failed } = useLoad(props.run, () => props.query().then((q) => unmatched(q, config, 200)), [props.run]);

  const header = [...keys, "Units", t.measure, "Price", "Compared against", "Reference price", "Effect"];
  const cells = (row: Record<string, unknown>) => [
    ...keys.map((c) => display(row[c])),
    Number(row.q1),
    Number(row.s1),
    Number(row.s1) / Number(row.q1),
    matchLabel(config, Number(row.match_level)),
    row.ref_price === null ? "" : Number(row.ref_price),
    Number(row.new_config),
  ];

  if (failed) return <QueryFailed />;
  const rows = loaded?.key === props.run ? loaded.value : null;
  if (rows === null) return <p className="hint">Checking for configurations with no prior match…</p>;
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
                {keys.map((c) => <TextCell key={c} value={row[c]} />)}
                <td className="num">{whole(Number(row.q1))}</td>
                <td className="num">{whole(Number(row.s1))}</td>
                <td className="num">{price(Number(row.s1) / Number(row.q1))}</td>
                <td>{matchLabel(config, Number(row.match_level))}</td>
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
