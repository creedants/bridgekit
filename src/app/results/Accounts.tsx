import { accountBridge, measureName, type AccountGroup, type Query } from "../../engine.ts";
import { percent, signedWhole, whole } from "../format.ts";
import type { Run } from "../Results.tsx";
import { agree } from "../SetupPanel.tsx";
import { Kpi, QueryFailed, TextCell, useLoad } from "./shared.tsx";

const ACCOUNT_LABELS: Record<AccountGroup["status"], string> = {
  new: "New",
  lost: "Lost",
  growing: "Growing",
  shrinking: "Shrinking",
};

/** The first text column that names an account, or "" when none does. */
export function accountGuess(textColumns: readonly string[]): string {
  return textColumns.find((c) => /customer|account|client|parent|sold.?to|buyer/i.test(c)) ?? "";
}

export function Accounts(props: {
  run: Run;
  query: (() => Promise<Query>) | null;
  column: string;
  onColumn: (column: string) => void;
}) {
  const { config, textColumns } = props.run;
  const column = props.column;
  const live = props.query !== null;
  const run = props.query;
  // The figures are kept with the column they were fetched for, so the four
  // groups can never appear under another column's name.
  const { loaded, failed } = useLoad(
    column,
    !column || run === null ? null : () => run().then((query) => accountBridge(query, config, column)),
    [props.run, column, live],
  );
  const toolbar = (
    <div className="toolbar">
      <label>
        Account column
        <select value={column} onChange={(e) => props.onColumn(e.target.value)}>
          <option value="">Choose a column</option>
          {textColumns.map((c) => <option key={c}>{c}</option>)}
        </select>
      </label>
      <span className="hint">
        Any column works: customer, region, sales rep. It does not have to be an attribute of the bridge.
      </span>
    </div>
  );
  if (textColumns.length === 0) return <p className="hint">This view needs a text column such as customer.</p>;
  if (column === "") {
    return (
      <div>
        {toolbar}
        <p className="hint">Choose the account column to see these groups.</p>
      </div>
    );
  }
  if (failed) {
    return (
      <div>
        {toolbar}
        <QueryFailed />
      </div>
    );
  }
  const groups = loaded?.key === column ? loaded.value : null;
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
