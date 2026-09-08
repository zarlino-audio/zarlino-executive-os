/** Core console views: Overview, Activity, Tasks, Approvals. */
import { useEffect, useMemo, useState } from "react";
import { api, type DataBundle, type Task } from "../api";
import { Badge, FuelGauge, fmt, timeAgo } from "../lib/entertain";

interface ViewProps {
  data: DataBundle;
  mutate: () => Promise<void>;
  notify: (msg: string, ok?: boolean) => void;
}

// ---- Overview ---------------------------------------------------------------

export function Overview({ data, mutate, notify }: ViewProps) {
  const c = data.counters;
  const budget = data.budget;
  const st = data.state;
  const fuelPct = budget.monthly > 0 ? Math.round((budget.spentThisMonth / budget.monthly) * 100) : 0;

  const setControl = async (patch: Parameters<typeof api.controlExecutive>[0], label: string, wasOn: boolean) => {
    // Confirm serious toggles so one mis-click can't pause the OS, kill
    // spending/deploys, or grant full autonomy.
    const isDanger =
      patch.paused !== undefined || patch.spendingDisabled !== undefined || patch.deploymentsDisabled !== undefined || patch.fullAccess !== undefined;
    if (isDanger) {
      const turningOn = patch.paused === true || patch.spendingDisabled === true || patch.deploymentsDisabled === true || patch.fullAccess === true;
      if (!window.confirm(`${turningOn ? "ENABLE" : "DISABLE"} ${label.replace(/^[^\s]+\s/, "")}?`)) return;
    }
    try {
      await api.controlExecutive(patch);
      await mutate();
      const nowOn = patch.paused === true || patch.spendingDisabled === true || patch.deploymentsDisabled === true || patch.fullAccess === true;
      const off = patch.paused === false || patch.spendingDisabled === false || patch.deploymentsDisabled === false || patch.delegateMode === false || patch.fullAccess === false;
      if (patch.autonomyMode) notify(`Autonomy mode → ${patch.autonomyMode}`);
      else if (nowOn) notify(`${label} ON`);
      else if (off) notify(`${label} OFF`);
      else if (wasOn) notify(`${label} OFF`);
      else notify(`${label} ON`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), false);
    }
  };

  const controlToggles: Array<{
    key: "paused" | "spendingDisabled" | "deploymentsDisabled" | "delegateMode" | "fullAccess";
    on: boolean;
    label: string;
    danger?: boolean;
    hint: string;
  }> = [
    { key: "paused", on: st?.paused === 1, label: "⏸ Pause executive", danger: true, hint: "Stop all autonomous work" },
    { key: "spendingDisabled", on: st?.spending_disabled === 1, label: "🚫 Disable spending", danger: true, hint: "Kill-switch: no money moves" },
    { key: "deploymentsDisabled", on: st?.deployments_disabled === 1, label: "🚫 Disable deploys", danger: true, hint: "Kill-switch: no production deploys" },
    { key: "delegateMode", on: st?.delegate_mode === 1, label: "🤝 Delegate mode", hint: "Allow MEDIUM-risk reversible actions" },
    { key: "fullAccess", on: st?.full_access === 1, label: "🔓 Full access", danger: true, hint: "Autonomous deploy + HIGH reversible + spend" },
  ];

  return (
    <div>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2>Executive control</h2>
          <div className="row">
            <Badge tone={(st?.status ?? "GREEN") === "GREEN" ? "ok" : "warn"}>{st?.status ?? "—"}</Badge>
            <Badge>{st?.autonomy_mode ?? "—"}</Badge>
            {st?.paused === 1 && <Badge tone="fail">PAUSED</Badge>}
            {st?.full_access === 1 && <Badge tone="fail">FULL ACCESS</Badge>}
          </div>
        </div>
        {st ? (
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
            {controlToggles.map((t) => (
              <button
                key={t.key}
                className={`control-toggle ${t.on ? "on" : ""} ${t.danger ? "danger" : ""}`}
                title={t.hint}
                aria-label={t.label}
                onClick={() => setControl({ [t.key]: !t.on } as Parameters<typeof api.controlExecutive>[0], t.label, t.on)}
              >
                <span>{t.label}</span>
                <span className="control-state">{t.on ? "ON" : "off"}</span>
              </button>
            ))}
            <label className="control-autonomy">
              <span>Autonomy mode</span>
              <select
                className="sel"
                value={st.autonomy_mode ?? "CONTROLLED"}
                onChange={(e) => setControl({ autonomyMode: e.target.value }, `autonomy → ${e.target.value}`, false)}
              >
                <option value="CONTROLLED">CONTROLLED</option>
                <option value="DELEGATED">DELEGATED</option>
                <option value="FULL">FULL</option>
              </select>
            </label>
          </div>
        ) : (
          <p className="muted">No executive state loaded.</p>
        )}
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2>Executive state</h2>
          <div className="row">
            <Badge tone={(data.state?.status ?? "GREEN") === "GREEN" ? "ok" : "warn"}>{data.state?.status ?? "—"}</Badge>
            <Badge>{data.state?.autonomy_mode ?? "—"}</Badge>
          </div>
        </div>
        <div className="row" style={{ gap: 20, flexWrap: "wrap" }}>
          <FuelGauge used={budget.spentThisMonth} budget={budget.monthly} label="AI budget (month)" />
          {budget.daily > 0 ? (
            <FuelGauge used={budget.tokensToday} budget={budget.daily} label="tokens today" />
          ) : (
            <div className="metric">
              <div className="value">{fmt(budget.tokensToday)}</div>
              <div className="key">tokens today · no daily cap set</div>
            </div>
          )}
        </div>
        <p className="muted">
          Spent today <b>${fmt(budget.spentToday, 2)}</b> · month <b>${fmt(budget.spentThisMonth, 2)}</b> of ${fmt(budget.monthly)} ({fuelPct}%) ·{" "}
          {fmt(budget.tokensToday)} tokens today · {fmt(budget.tokensThisMonth)} this month
          {data.doctorLastRun ? <> · Doctor last run <b>{timeAgo(data.doctorLastRun.runAt)}</b></> : null}
        </p>
      </div>

      <div className="grid">
        <Metric label="Open tasks" value={c.openTasks ?? 0} />
        <Metric label="Pending approvals" value={c.pendingApprovals ?? 0} />
        <Metric label="Open risks" value={c.openRisks ?? 0} />
        <Metric label="Products" value={c.products ?? 0} />
        <Metric label="Pipeline gates" value={c.gates ?? 0} />
        <Metric label="Agent runs" value={c.runsRunning ?? 0} />
        <Metric label="Local pending" value={c.localPending ?? 0} />
        <Metric label="Overdue reminders" value={c.overdueReminders ?? 0} />
        <Metric label="Contradictions" value={c.contradictionsOpen ?? 0} tone={(c.contradictionsOpen ?? 0) > 0 ? "warn" : undefined} />
        <Metric label="Assignments open" value={c.assignmentsOpen ?? 0} />
        <Metric label="Reviews pending" value={c.pendingReviews ?? 0} tone={(c.pendingReviews ?? 0) > 0 ? "warn" : undefined} />
      </div>

      <div className="card section-gap">
        <h2>🎯 Needs the Founder</h2>
        <p className="muted">
          A live digest of what only you can action — overdue reminders, pending approvals, open contradictions, and top risks.
        </p>
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div className="card sub">
            <h3>⏰ Overdue reminders ({data.founderBrief?.overdueReminders.length ?? 0})</h3>
            {(data.founderBrief?.overdueReminders ?? []).length === 0 ? (
              <p className="muted">None overdue 🎉</p>
            ) : (
              <ul className="founder-list">
                {(data.founderBrief?.overdueReminders ?? []).map((r, i) => (
                  <li key={i}><span className="muted mono">{timeAgo(String((r as { due_at?: string }).due_at ?? ""))}</span> — {String((r as { title?: string }).title ?? "")}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="card sub">
            <h3>✋ Pending approvals ({data.founderBrief?.pendingApprovals.length ?? 0})</h3>
            {(data.founderBrief?.pendingApprovals ?? []).length === 0 ? (
              <p className="muted">Nothing waiting on you</p>
            ) : (
              <ul className="founder-list">
                {(data.founderBrief?.pendingApprovals ?? []).map((a, i) => (
                  <li key={i}><span className="muted mono">{timeAgo(String((a as { created_at?: string }).created_at ?? ""))}</span> — {String((a as { summary?: string }).summary ?? (a as { title?: string }).title ?? "")}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="card sub">
            <h3>⚠️ Open contradictions ({data.founderBrief?.openContradictions.length ?? 0})</h3>
            {(data.founderBrief?.openContradictions ?? []).length === 0 ? (
              <p className="muted">No open contradictions</p>
            ) : (
              <ul className="founder-list">
                {(data.founderBrief?.openContradictions ?? []).map((c2, i) => (
                  <li key={i}><span className="muted mono">{String((c2 as { kind?: string }).kind ?? "")}</span> — {String((c2 as { detail?: string }).detail ?? "").slice(0, 90)}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="card sub">
            <h3>🚨 Top risks ({data.founderBrief?.topRisks.length ?? 0})</h3>
            {(data.founderBrief?.topRisks ?? []).length === 0 ? (
              <p className="muted">No open risks</p>
            ) : (
              <ul className="founder-list">
                {(data.founderBrief?.topRisks ?? []).map((rk, i) => (
                  <li key={i}><span className="muted mono">{String((rk as { severity?: string }).severity ?? "")}</span> — {String((rk as { title?: string }).title ?? (rk as { description?: string }).description ?? "").slice(0, 90)}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="card sub">
            <h3>🎧 Reviews to vet ({data.founderBrief?.pendingReviews.length ?? 0})</h3>
            {(data.founderBrief?.pendingReviews ?? []).length === 0 ? (
              <p className="muted">Nothing to listen to or look at</p>
            ) : (
              <ul className="founder-list">
                {(data.founderBrief?.pendingReviews ?? []).map((rv, i) => (
                  <li key={i}>
                    <span className="muted mono">{String((rv as { kind?: string }).kind ?? "").toUpperCase()}</span> — {String((rv as { title?: string }).title ?? "").slice(0, 90)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <div className="card section-gap">
        <h2>Products</h2>
        {data.products.length === 0 ? (
          <p className="muted">No products.</p>
        ) : (
          <div className="grid">
            {data.products.map((p) => (
              <div className="metric" key={p.id}>
                <div className="value" style={{ fontSize: 16 }}>{p.name}</div>
                <div className="key">
                  {p.status} · v{p.version ?? "—"} {p.price ? `· $${p.price}` : ""}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" | "fail" }) {
  return (
    <div className="metric">
      <div className="value" style={tone === "warn" ? { color: "var(--warn)" } : undefined}>{value}</div>
      <div className="key">{label}</div>
    </div>
  );
}

// ---- Activity ---------------------------------------------------------------

export function Activity({ data }: ViewProps) {
  const audit = data.audit ?? [];
  const tools = data.toolExecutions ?? [];
  return (
    <div>
      <div className="card">
        <h2>Audit trail</h2>
        {audit.length === 0 ? (
          <p className="muted">No audit entries yet.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th></tr>
            </thead>
            <tbody>
              {audit.map((a, i) => (
                <tr key={i}>
                  <td className="mono muted">{timeAgo(String(a.created_at ?? ""))}</td>
                  <td>{String(a.actor ?? "")}</td>
                  <td className="mono">{String(a.action ?? "")}</td>
                  <td className="mono muted">{String(a.entity_type ?? "")}:{String(a.entity_id ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h2>Tool executions</h2>
        {tools.length === 0 ? (
          <p className="muted">No tool executions recorded.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Time</th><th>Tool</th><th>Verdict</th><th>Status</th></tr>
            </thead>
            <tbody>
              {tools.map((t, i) => (
                <tr key={i}>
                  <td className="mono muted">{timeAgo(String(t.created_at ?? ""))}</td>
                  <td className="mono">{String(t.tool_name ?? "")}</td>
                  <td><Badge tone={String(t.verdict ?? "") === "APPROVED" ? "ok" : "warn"}>{String(t.verdict ?? "")}</Badge></td>
                  <td><Badge tone={String(t.status ?? "") === "SUCCESS" ? "ok" : "warn"}>{String(t.status ?? "")}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---- Tasks ------------------------------------------------------------------

export function Tasks({ data, mutate, notify }: ViewProps) {
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("P2");
  const [busy, setBusy] = useState(false);
  const tasks = useMemo(() => data.tasks ?? [], [data]);
  const open = tasks.filter((t) => t.status === "OPEN");
  const inProg = tasks.filter((t) => t.status === "IN_PROGRESS");
  const blocked = tasks.filter((t) => t.status === "BLOCKED");
  const done = tasks.filter((t) => t.status === "DONE");

  const create = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      await api.createTask(title.trim(), undefined, priority);
      setTitle("");
      await mutate();
      notify("Task created");
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), false);
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (t: Task, status: string) => {
    try {
      await api.updateTask(t.id, { status });
      await mutate();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), false);
    }
  };

  const board: Array<{ status: string; label: string; items: Task[] }> = [
    { status: "OPEN", label: "To Do", items: open },
    { status: "IN_PROGRESS", label: "In Progress", items: inProg },
    { status: "BLOCKED", label: "Blocked", items: blocked },
    { status: "DONE", label: "Done", items: done },
  ];

  return (
    <div>
      <div className="card">
        <h2>Create task</h2>
        <div className="row">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Investigate the noisy threshold in ZScorch" style={{ flex: 1 }} />
          <select value={priority} onChange={(e) => setPriority(e.target.value)} className="sel">
            <option value="P0">P0</option>
            <option value="P1">P1</option>
            <option value="P2">P2</option>
            <option value="P3">P3</option>
          </select>
          <button className="action" onClick={create} disabled={busy || !title.trim()}>Create</button>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <span className="chip">🩺 {open.length} to do</span>
          <span className="chip">▶ {inProg.length} in progress</span>
          <span className="chip">⛔ {blocked.length} blocked</span>
          <span className="chip">✔ {done.length} done</span>
        </div>
      </div>

      <div className="task-board">
        {board.map((col) => (
          <div className="task-col" key={col.status}>
            <h3>{col.label} <span className="muted">({col.items.length})</span></h3>
            {col.items.length === 0 && <p className="muted">—</p>}
            {col.items.slice(0, 40).map((t) => (
              <div className="task-card" key={t.id}>
                <div className="task-title">{t.title}</div>
                <div className="row" style={{ gap: 6, marginTop: 8 }}>
                  <Badge tone={t.priority === "P0" ? "fail" : t.priority === "P1" ? "warn" : undefined}>{t.priority}</Badge>
                  <button className="mini" onClick={() => setStatus(t, col.status === "OPEN" ? "IN_PROGRESS" : col.status === "IN_PROGRESS" ? "DONE" : "OPEN")}>
                    {col.status === "OPEN" ? "▶ Start" : col.status === "IN_PROGRESS" ? "✔ Done" : "↩ Reopen"}
                  </button>
                  {col.status === "BLOCKED" && (
                    <button className="mini" onClick={() => setStatus(t, "IN_PROGRESS")}>Unblock</button>
                  )}
                  {(col.status === "OPEN" || col.status === "IN_PROGRESS") && (
                    <button className="mini" onClick={() => setStatus(t, "BLOCKED")}>⛔</button>
                  )}
                </div>
              </div>
            ))}
            {col.items.length > 40 && <p className="muted">…and {col.items.length - 40} more — open them via the agent or a narrowed search.</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Approvals --------------------------------------------------------------

export function Approvals({ mutate, notify }: ViewProps) {
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState<Array<Record<string, unknown>>>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");

  const load = async () => {
    try {
      const r = await api.approvals();
      setList(r.approvals as unknown as Array<Record<string, unknown>>);
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    void load();
    // Auto-refresh while the view is open (30s) so new requests appear.
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const decide = async (id: string, decision: string) => {
    setBusy(true);
    try {
      await api.decideApproval(id, decision);
      await load();
      await mutate();
      notify(`Approval ${decision.toLowerCase()}`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <div className="card">
        <h2>Approval requests</h2>
        {!loaded ? (
          <p className="muted">Loading…</p>
        ) : err ? (
          <div className="error-box">
            Couldn't load approvals: {err}{" "}
            <button className="mini" onClick={() => void load()}>Retry</button>
          </div>
        ) : list.length === 0 ? (
          <p className="muted">No approval requests.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Title</th><th>Status</th><th>Priority</th><th>Detail</th><th>Action</th></tr>
            </thead>
            <tbody>
              {list.map((a, i) => (
                <tr key={i}>
                  <td>{String(a.title ?? a.action_label ?? "")}</td>
                  <td><Badge tone={String(a.status) === "APPROVED" ? "ok" : String(a.status) === "REJECTED" ? "fail" : "warn"}>{String(a.status)}</Badge></td>
                  <td><Badge>{String(a.priority ?? "")}</Badge></td>
                  <td className="muted">{String(a.detail ?? "")}</td>
                  <td>
                    {String(a.status) === "PENDING" ? (
                      <div className="row">
                        <button className="ghost" disabled={busy} onClick={() => decide(String(a.id), "APPROVED")}>Approve</button>
                        <button className="ghost" disabled={busy} onClick={() => decide(String(a.id), "REJECTED")}>Reject</button>
                      </div>
                    ) : (
                      <span className="muted">{String(a.decided_by ?? "")}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

