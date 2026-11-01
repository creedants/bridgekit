import { useEffect, useState } from "react";
import { commentary } from "../../commentary.ts";
import { accountBridge, drill, priceDistribution, type Query } from "../../engine.ts";
import { summarize, type BridgeSummary, type RoundedBridge } from "../../summary.ts";
import { requestCommentary } from "../account.ts";
import { saveOnce } from "../files.ts";
import { buildReport } from "../report.ts";
import type { Freshness, NamesChoice, Run } from "../Results.tsx";
import { useCommentaryOffer } from "../useConfig.ts";
import { CopyButton } from "./shared.tsx";

const AI_COMMENTARY = import.meta.env && import.meta.env.VITE_AI_COMMENTARY === "1";

type MoverRows = Awaited<ReturnType<typeof drill>>;

/**
 * The downloaded report. It takes the exact result and rounds it once in
 * buildReport, so the file shows the same amounts and exact percentages as the
 * page. Exported so a test can drive the path the Download button uses.
 */
export async function summaryReport(
  props: { run: Run; result: Run["result"]; query: () => Promise<Query> } & NamesChoice,
  movers: MoverRows | null,
): Promise<string> {
  const { config, setup } = props.run;
  const first = config.levels[0];
  // A render without the choice reads unticked and ignores ticks; App always passes both.
  const omitNames = props.omitNames ?? false;
  const query = await props.query();
  const rows = movers ?? (await drill(query, config, { columns: first.columns, limit: 15 }));
  const accountColumn = props.run.textColumns.find((c) => /customer|account|client|parent|sold.?to|buyer/i.test(c));
  const canvas = document.querySelector<HTMLCanvasElement>(".waterfall canvas");
  // Offered only when the report would carry a name that leaving out removes.
  const hasNames =
    !props.run.sample ||
    setup.filters.some((filter) => filter.values.length > 0) ||
    rows.length > 0 ||
    config.levels.some((level) => level.name !== level.columns.join(" + "));
  return buildReport({
    config,
    result: props.result,
    chartUrl: canvas?.toDataURL("image/png"),
    description: props.run.description,
    setup: props.run.setup,
    source: props.run.source,
    movers: { label: first.name, rows, columns: first.columns },
    priceBands: (await priceDistribution(query, config)).buckets,
    accounts: accountColumn
      ? { column: accountColumn, groups: await accountBridge(query, config, accountColumn) }
      : undefined,
    omitNames: hasNames && omitNames,
  });
}

export function Summary(
  props: { run: Run; result: Run["result"]; shown: RoundedBridge; query: () => Promise<Query> } & NamesChoice & Freshness,
) {
  const [movers, setMovers] = useState<MoverRows | null>(null);
  const [building, setBuilding] = useState(false);
  // A render without the choice reads unticked and ignores ticks; App always passes both.
  const omitNames = props.omitNames ?? false;
  const fresh = props.fresh === true;
  const paragraphs = commentary(props.result, props.run.config, props.shown);
  const { config } = props.run;
  const first = config.levels[0];
  useEffect(() => {
    let stale = false;
    props
      .query()
      .then((query) => drill(query, config, { columns: first.columns, limit: 15 }))
      .then((rows) => !stale && setMovers(rows))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [props.run]);
  // Offered while the prefetch has not answered: an unknown is not "no names".
  const hasNames =
    !props.run.sample ||
    props.run.setup.filters.some((filter) => filter.values.length > 0) ||
    movers === null ||
    movers.length > 0 ||
    config.levels.some((level) => level.name !== level.columns.join(" + "));
  const buildHtml = async () => summaryReport(props, movers);
  const saveReport = () => {
    if (!fresh) return;
    return saveOnce(
      `bridge-${config.prior}-to-${config.current}.html`,
      async () => {
        setBuilding(true);
        try {
          return await buildHtml();
        } finally {
          setBuilding(false);
        }
      },
      "text/html",
    );
  };
  return (
    <div className="summary">
      <div className="toolbar">
        <h3>Summary</h3>
        <span className="actions">
          <CopyButton text={() => paragraphs.join("\n\n")} />
          {hasNames && (
            <label className="check">
              <input type="checkbox" checked={omitNames} onChange={(e) => props.onOmitNames?.(e.target.checked)} />
              Leave the file name, filter values and mover names out of the report
            </label>
          )}
          <button onClick={saveReport} disabled={building || !fresh}>Download report</button>
        </span>
      </div>
      {paragraphs.map((p) => <p key={p}>{p}</p>)}
      <p className="hint">Written from fixed sentence patterns, so the same bridge always gives the same text.</p>
      {AI_COMMENTARY && <AiOffer summary={summarize(props.result, props.run.config)} />}
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
  const write = async () => {
    setState({ status: "busy" });
    try {
      const paragraphs = await requestCommentary(props.summary);
      setState({ status: "done", paragraphs });
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
            <CopyButton text={() => state.paragraphs.join("\n\n")} />
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
            PVM Bridge&rsquo;s server, which passes them to Anthropic. No rows are sent, and no values from your data such as
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
