import { useEffect, useRef, useState } from "react";
import type { BridgeSummary } from "../summary.ts";
import * as api from "./account.ts";
import { signedWhole, whole } from "./format.ts";
import type { Setup } from "./setup.ts";

/**
 * Pro workspaces: sign in, save setups and bridge totals, share them with a
 * team. Shown only in builds with VITE_WORKSPACES=1. What is saved is the
 * setup without filter values and the bridge totals; the file stays in the tab.
 */
export default function WorkspacePanel(props: {
  columns: string[];
  setup: Setup | null;
  /** The current bridge, when it matches the setup on screen. */
  bridge: { summary: BridgeSummary; setup: Setup } | null;
  onUseSetup: (setup: Setup) => void;
}) {
  const [config, setConfig] = useState<api.Config | null>(null);
  const [user, setUser] = useState<api.User | null | undefined>(undefined);
  const [workspaces, setWorkspaces] = useState<api.Workspace[]>([]);
  const [active, setActive] = useState("");
  // Plans are keyed by workspace, so a read for one workspace never changes
  // what another workspace shows.
  const [plans, setPlans] = useState<Record<string, { role: string; plan: api.Plan }>>({});
  const [setups, setSetups] = useState<api.SavedSetup[]>([]);
  const [bridges, setBridges] = useState<api.SavedBridge[]>([]);
  const [viewing, setViewing] = useState<api.SavedBridge | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function act(work: () => Promise<unknown>, done = "") {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
      setMessage(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function loadWorkspaces(prefer?: string) {
    const list = await api.listWorkspaces();
    setWorkspaces(list);
    setActive((current) => api.preferredWorkspace(list, prefer, current));
  }

  // The checkout return lives in its own state, so a generic action message
  // never writes over the confirmation.
  const checkoutReturn = api.useCheckoutReturn({
    active,
    plans,
    onPlan: (workspaceId, found) => setPlans((all) => ({ ...all, [workspaceId]: found })),
    enabled: user !== null && user !== undefined && active !== "",
  });

  // The startup reads. Try again runs them once more over the same mount, so
  // the analysis on screen is untouched. The guard keeps a second press from
  // starting a second run, and the message stays until a run succeeds.
  const starting = useRef(false);
  const start = async () => {
    if (starting.current) return;
    starting.current = true;
    try {
      const found = await api.getConfig();
      setConfig(found);
      if (!accountsOpen(found)) return;
      const signedIn = await api.getUser();
      setUser(signedIn);
      // Both startup reads answered, so the failure sentence no longer applies.
      setError("");
      if (!signedIn) return;
      // An invitation link is /app/?invitation=ID; accept it once signed in.
      // The link is taken out of the address as soon as it is accepted, so a
      // retry after a later read failed does not send the write again.
      const invitation = new URLSearchParams(location.search).get("invitation");
      if (invitation) {
        await api.acceptInvitation(invitation);
        history.replaceState(null, "", location.pathname);
      }
      // Paddle's checkout returns to /app/?subscribed=1; its confirmation reaches the server separately.
      const returning = checkoutReturn.returning;
      await loadWorkspaces(returning ?? undefined);
      if (new URLSearchParams(location.search).has("subscribed")) history.replaceState(null, "", location.pathname);
      if (invitation) setMessage("You have joined the workspace.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      starting.current = false;
    }
  };

  useEffect(() => {
    void start();
  }, []);

  const columnsKey = props.columns.join("|");
  useEffect(() => {
    if (!active) return;
    const requested = active;
    act(async () => {
      const [found, saved] = await Promise.all([api.getPlan(requested), api.listBridges(requested)]);
      setPlans((all) => ({ ...all, [requested]: found }));
      setBridges(saved);
      setSetups(props.columns.length ? await api.listSetups(requested, props.columns) : []);
    });
  }, [active, columnsKey]);

  // Nothing is known until the config and the session answer, so nothing
  // renders; a read that really failed keeps its message and its retry.
  if (config === null) return error === "" ? null : loadingShell(error, start);
  if (!accountsOpen(config)) return null;
  if (user === undefined) return error === "" ? null : loadingShell(error, start);
  if (user === null) return <SignIn config={config} busy={busy} error={error} message={message} act={act} />;

  const plan = plans[active] ?? null;
  const billing = api.billingView(plan?.plan ?? null, plan?.role ?? null, config.billing);
  return (
    <fieldset className="team">
      <legend>Workspace</legend>
      <p className="hint">
        Signed in as {user.email}.{" "}
        <button className="link" onClick={() => act(async () => { await api.signOut(); setUser(null); })}>Sign out</button>
      </p>

      {workspaces.length === 0 ? (
        <CreateWorkspace busy={busy} onCreate={(name) => act(async () => loadWorkspaces((await api.createWorkspace(name)).id))} />
      ) : (
        <>
          {workspaces.length > 1 && (
            <select aria-label="Workspace" value={active} onChange={(e) => setActive(e.target.value)}>
              {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          )}
          {workspaces.length === 1 && <p><b>{workspaces[0].name}</b></p>}
          {plan && (
            <>
              {billing.pro && <p className="hint">{billing.pro}</p>}
              {billing.paused && <p className="hint">{billing.paused}</p>}
              {billing.manage && <ManageBilling busy={busy} onManage={() => act(async () => { location.href = (await api.openPortal(active)).portalUrl; })} />}
              {billing.subscribe && (
                <Subscribe
                  canManage={billing.canManage}
                  billing={config?.billing ?? false}
                  busy={busy}
                  onSubscribe={(seats) =>
                    act(async () => {
                      // Record the workspace only once the checkout exists, then
                      // leave for it. A refused checkout records nothing.
                      const { checkoutUrl } = await api.checkout(active, seats);
                      api.rememberCheckoutWorkspace(active);
                      location.href = checkoutUrl;
                    })
                  }
                />
              )}
            </>
          )}

          {props.columns.length > 0 && (
            <>
              <h4>Setups for these columns</h4>
              {setups.length === 0 && <p className="hint">None saved yet.</p>}
              <ul className="saved">
                {setups.map((s) => (
                  <li key={s.id}>
                    <span title={`${s.createdBy ?? ""} · ${s.createdAt.slice(0, 10)}`}>{s.name}</span>
                    <button className="link" onClick={() => { props.onUseSetup(s.setup); setMessage(`Using “${s.name}”.`); }}>Use</button>
                    <button className="icon" aria-label={`Delete ${s.name}`} onClick={() => act(async () => { await api.deleteSaved(active, "setups", s.id); setSetups((all) => all.filter((x) => x.id !== s.id)); })}>×</button>
                  </li>
                ))}
              </ul>
              {props.setup && (
                <SaveForm
                  label="Save setup"
                  initial="Setup"
                  disabled={!plan?.plan.pro || busy}
                  onSave={(name) =>
                    act(async () => {
                      await api.saveSetup(active, name, props.columns, { ...props.setup!, filters: [] });
                      setSetups(await api.listSetups(active, props.columns));
                    }, "Setup saved. Filter selections are not saved.")
                  }
                />
              )}
            </>
          )}

          <h4>Saved bridges</h4>
          {bridges.length === 0 && <p className="hint">None saved yet.</p>}
          <ul className="saved">
            {bridges.map((b) => (
              <li key={b.id}>
                <button className="link" onClick={() => setViewing(b)}>{b.name}</button>
                <span className="hint">{b.createdAt.slice(0, 10)}</span>
                <button className="icon" aria-label={`Delete ${b.name}`} onClick={() => act(async () => { await api.deleteSaved(active, "bridges", b.id); setBridges((all) => all.filter((x) => x.id !== b.id)); })}>×</button>
              </li>
            ))}
          </ul>
          {props.bridge && (
            <SaveForm
              label="Save this bridge"
              initial={`${props.bridge.summary.prior} to ${props.bridge.summary.current}`}
              disabled={!plan?.plan.pro || busy}
              onSave={(name) =>
                act(async () => {
                  const { summary, setup } = props.bridge!;
                  await api.saveBridge(active, {
                    name,
                    columns: props.columns,
                    setup: { ...setup, filters: [] },
                    summary,
                    filterColumns: setup.filters.filter((f) => f.values.length > 0).map((f) => f.column),
                  });
                  setBridges(await api.listBridges(active));
                }, "Bridge totals saved.")
              }
            />
          )}
          {props.bridge && <p className="hint">Saves the totals and the setup. Not the file, rows or filter selections.</p>}

          <Members workspace={active} canManage={billing.canManage} seats={plan?.plan.seats ?? 1} act={act} />
        </>
      )}

      {checkoutReturn.sentence && <p className="hint" role="status">{checkoutReturn.sentence}</p>}
      {message && <p className="hint" role="status">{message}</p>}
      {error && <p className="error">{error}</p>}

      <details className="danger">
        <summary>Delete account</summary>
        <p className="hint">Deletes your account. Workspaces where you are the only member are deleted with everything saved in them. A paid subscription is cancelled first; if it cannot be cancelled, nothing is deleted.</p>
        <button
          disabled={busy}
          onClick={() => {
            if (confirm("Delete your PVM Bridge account? This cannot be undone.")) {
              act(async () => { await api.deleteAccount(); setUser(null); }, "Account deleted.");
            }
          }}
        >
          Delete my account
        </button>
      </details>

      {viewing && <BridgeDialog bridge={viewing} onClose={() => setViewing(null)} />}
    </fieldset>
  );
}

type Act = (work: () => Promise<unknown>, done?: string) => Promise<void>;

function accountsOpen(config: api.Config): boolean {
  return config.email === true || config.providers.length > 0;
}

function loadingShell(error: string, onRetry: () => void) {
  return (
    <fieldset className="team">
      <legend>Workspace</legend>
      {error && <p className="error">{error}</p>}
      <button onClick={onRetry}>Try again</button>
    </fieldset>
  );
}

function SignIn(props: { config: api.Config; busy: boolean; error: string; message: string; act: Act }) {
  const [email, setEmail] = useState("");
  const labels = { microsoft: "Microsoft", google: "Google" };
  return (
    <fieldset className="team">
      <legend>Workspace</legend>
      <p className="hint">With Pro, setups and bridge totals are saved to a workspace your team can open from any computer. Your file is never uploaded.</p>
      {props.config.email === true && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            props.act(() => api.emailSignIn(email), "Check your email for a sign-in link.");
          }}
        >
          <input type="email" required placeholder="Work email" aria-label="Work email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button disabled={props.busy || !email}>Email me a link</button>
        </form>
      )}
      {props.config.providers.map((p) => (
        <button key={p} disabled={props.busy} onClick={() => props.act(() => api.providerSignIn(p))}>Sign in with {labels[p]}</button>
      ))}
      {props.message && <p className="hint" role="status">{props.message}</p>}
      {props.error && <p className="error">{props.error}</p>}
    </fieldset>
  );
}

function CreateWorkspace(props: { busy: boolean; onCreate: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); props.onCreate(name.trim()); }}>
      <input required maxLength={60} placeholder="Workspace name, e.g. Pricing team" aria-label="Workspace name" value={name} onChange={(e) => setName(e.target.value)} />
      <button disabled={props.busy || !name.trim()}>Create workspace</button>
    </form>
  );
}

function Subscribe(props: { canManage: boolean; billing: boolean; busy: boolean; onSubscribe: (seats: number) => void }) {
  const [seats, setSeats] = useState(1);
  if (!props.billing) return <p className="hint">Saving needs Pro, which is not on sale yet.</p>;
  if (!props.canManage) return <p className="hint">Saving needs Pro. Ask the workspace owner to subscribe.</p>;
  return (
    <>
      <p className="hint">Saving needs Pro. <a href="/#pricing" target="_blank" rel="noreferrer">Pricing</a></p>
      <div className="row">
        <label className="hint">
          Seats <input type="number" min={1} max={200} value={seats} onChange={(e) => setSeats(Math.max(1, Math.floor(Number(e.target.value) || 1)))} style={{ width: 64 }} />
        </label>
        <button disabled={props.busy} onClick={() => props.onSubscribe(seats)}>Subscribe</button>
      </div>
      <p className="hint">Payment is taken by Paddle, our reseller, on its own checkout page.</p>
    </>
  );
}

function ManageBilling(props: { busy: boolean; onManage: () => void }) {
  return (
    <div className="row">
      <button disabled={props.busy} onClick={props.onManage}>Manage billing</button>
    </div>
  );
}

function SaveForm(props: { label: string; initial: string; disabled: boolean; onSave: (name: string) => void }) {
  const [name, setName] = useState(props.initial);
  useEffect(() => setName(props.initial), [props.initial]);
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); props.onSave(name.trim()); }}>
      <input required maxLength={120} aria-label={`${props.label}: name`} value={name} onChange={(e) => setName(e.target.value)} />
      <button disabled={props.disabled || !name.trim()}>{props.label}</button>
    </form>
  );
}

function Members(props: { workspace: string; canManage: boolean; seats: number; act: Act }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ members: api.Member[]; invitations: api.Invitation[] } | null>(null);
  const [email, setEmail] = useState("");
  const refresh = () => props.act(async () => setData(await api.getMembers(props.workspace)));
  useEffect(() => {
    if (open) refresh();
  }, [open, props.workspace]);
  const pending = data?.invitations.filter((i) => i.status === "pending") ?? [];
  return (
    <details className="members" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Members</summary>
      <ul className="saved">
        {data?.members.map((m) => (
          <li key={m.id}>
            <span>{m.user.name || m.user.email}</span>
            <span className="hint">{m.role}</span>
            {props.canManage && m.role !== "owner" && (
              <button className="icon" aria-label={`Remove ${m.user.email}`} onClick={() => props.act(async () => { await api.removeMember(props.workspace, m.id); await refresh(); })}>×</button>
            )}
          </li>
        ))}
        {pending.map((i) => <li key={i.id}><span>{i.email}</span><span className="hint">invited</span></li>)}
      </ul>
      {props.canManage && (
        <>
          <form className="row" onSubmit={(e) => { e.preventDefault(); props.act(async () => { await api.invite(props.workspace, email); setEmail(""); await refresh(); }, "Invitation sent."); }}>
            <input type="email" required placeholder="Colleague’s email" aria-label="Colleague’s email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <button disabled={!email}>Invite</button>
          </form>
          <p className="hint">{props.seats} {props.seats === 1 ? "seat" : "seats"}. Each member uses one.</p>
        </>
      )}
    </details>
  );
}

function BridgeDialog(props: { bridge: api.SavedBridge; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  const { summary, setup } = props.bridge;
  const ofPrior = (n: number) => (summary.priorTotal > 0 ? ((n / summary.priorTotal) * 100).toFixed(1) + "%" : "");
  return (
    <dialog ref={ref} className="saved-bridge" onClose={props.onClose}>
      <div className="toolbar">
        <h3>{props.bridge.name}</h3>
        <button onClick={() => ref.current?.close()}>Close</button>
      </div>
      <table>
        <tbody>
          <tr><td>{summary.measure} {summary.prior}</td><td className="num">{whole(summary.priorTotal)}</td><td /></tr>
          {summary.effects.map((e) => (
            <tr key={e.label}><td>{e.label}</td><td className="num">{signedWhole(e.value)}</td><td className="num">{ofPrior(e.value)}</td></tr>
          ))}
          <tr className="total"><td>{summary.measure} {summary.current}</td><td className="num">{whole(summary.currentTotal)}</td><td /></tr>
        </tbody>
      </table>
      <p className="hint">
        Attributes: {summary.attributes.join(", ")}. {(summary.exactMatchShare * 100).toFixed(1)}% of current units matched an exact prior configuration.
        {props.bridge.filterColumns.length > 0 && ` Filtered on ${props.bridge.filterColumns.join(", ")}; the selected values were not saved.`}
        {" "}Units: {setup.unitsColumn}. Sales: {setup.salesColumn}. Saved by {props.bridge.createdBy ?? "a former member"} on {props.bridge.createdAt.slice(0, 10)}.
      </p>
    </dialog>
  );
}
