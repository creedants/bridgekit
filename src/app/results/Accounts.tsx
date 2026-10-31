import { useEffect, useState } from "react";
import { accountBridge, measureName, type AccountGroup, type Query } from "../../engine.ts";
import { percent, signedWhole, whole } from "../format.ts";
import type { Run } from "../Results.tsx";
import { agree } from "../SetupPanel.tsx";
import { Kpi, TextCell } from "./shared.tsx";

const ACCOUNT_LABELS: Record<AccountGroup["status"], string> = {
  new: "New",
  lost: "Lost",
  growing: "Growing",
  shrinking: "Shrinking",
};

export function Accounts(props: { run: Run; query: (() => Promise<Query>) | null }) {
  const { config, textColumns } = props.run;
  const guess =
    textColumns.find((c) => /customer|account|client|parent|sold.?to|buyer/i.test(c)) ?? textColumns[0] ?? "";
  const [column, setColumn] = useState(guess);
  // The figures are kept with the column they were fetched for, so the four
  // groups can never appear under another column's name.
  const [fetched, setFetched] = useState<{ column: string; groups: AccountGroup[] } | null>(null);
  const live = props.query !== null;
  useEffect(() => {
    if (!column) return;
    const run = props.query;
    if (run === null) return;
    let stale = false;
    run()
      .then((query) => accountBridge(query, config, column))
      .then((result) => !stale && setFetched({ column, groups: result }));
    return () => {
      stale = true;
    };
  }, [props.run, column, live]);
  const toolbar = (
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
  );
  if (!column) return <p className="hint">This view needs a text column such as customer.</p>;
  const groups = fetched !== null && fetched.column === column ? fetched.groups : null;
  if (!groups) return <div>{toolbar}</div>;
  const by = Object.fromEntries(groups.map((g) => [g.status, g])) as Record<AccountGroup["status"], AccountGroup>;
  const existingPrior = by.lost.prior + by.growing.prior + by.shrinking.prior;
  const measure = measureName(config).toLowerCase();
  return (
    <div>
      {toolbar}
      <div className="kpis" style={{ marginBottom: 12 }}>
        {groups.map((g) => (
          <Kpi key={g.status} label={ACCOUNT_LABELS[g.status]} value={signedWhole(g.change)} note={accountNote(g.count, column)} />
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
                    <TextCell value={a.name} />
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

export function accountNote(count: number, column: string): string {
  return `${whole(count)} ${column} ${agree(count, "value")}`;
}
