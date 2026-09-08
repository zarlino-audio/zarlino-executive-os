/** Business views: Pipeline, Finance, Decisions & Risks, Catalog. */
import { useState } from "react";
import { api, type DataBundle } from "../api";
import { Badge, fmt, timeAgo } from "../lib/entertain";

interface ViewProps {
  data: DataBundle;
  mutate: () => Promise<void>;
  notify: (msg: string, ok?: boolean) => void;
}

const GATE_TONES: Record<string, string> = {
  PASSED: "ok",
  SHIPPED: "ok",
  IN_PROGRESS: "warn",
  BLOCKED: "fail",
  FAILED: "fail",
  NOT_STARTED: "",
};

// ---- Pipeline ---------------------------------------------------------------

export function Pipeline({ data, mutate, notify }: ViewProps) {
  const gates = data.pipeline ?? [];
  const products = data.products ?? [];
  const persons = data.persons ?? [];
  const [busy, setBusy] = useState<string | null>(null);

  const updateGate = async (id: string, status: string) => {
    setBusy(id);
    try {
      await api.updateGate(id, status);
      await mutate();
      notify(`Gate → ${status}`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), false);
    } finally {
      setBusy(null);
    }
  };

  const byProduct = products.map((p) => ({
    product: p,
    gates: gates.filter((g) => String(g.plugin_id) === p.name).sort((a, b) => Number(a.gate_number) - Number(b.gate_number)),
  }));

  return (
    <div>
      {byProduct.map(({ product, gates: gs }) => (
        <div className="card" key={product.id}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2>{product.name} <span className="muted">· {product.status}</span></h2>
            <Badge>{product.version ?? "—"}</Badge>
          </div>
          {gs.length === 0 ? (
            <p className="muted">No gates for this product.</p>
          ) : (
            <table>
              <thead>
                <tr><th>Gate</th><th>Name</th><th>Status</th><th>Owner</th><th>Set</th></tr>
              </thead>
              <tbody>
                {gs.map((g) => (
                  <tr key={String(g.id)}>
                    <td className="mono">G{String(g.gate_number)}</td>
                    <td>{String(g.gate_name ?? "")}</td>
                    <td><Badge tone={GATE_TONES[String(g.status)]}>{String(g.status)}</Badge></td>
                    <td className="muted">{String(g.owner_role ?? "")}</td>
                    <td>
                      <select
                        className="sel"
                        value={String(g.status)}
                        disabled={busy === g.id}
                        onChange={(e) => updateGate(String(g.id), e.target.value)}
                      >
                        {["NOT_STARTED", "IN_PROGRESS", "PASSED", "FAILED", "BLOCKED", "SHIPPED"].map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}

      <div className="card">
        <h2>Team & roles</h2>
        {persons.length === 0 ? (
          <p className="muted">No roles seeded.</p>
        ) : (
          <div className="grid">
            {persons.map((p, i) => (
              <div className="metric" key={i}>
                <div className="value" style={{ fontSize: 14 }}>{String(p.name ?? "")}</div>
                <div className="key">{String(p.role ?? "")}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Finance ----------------------------------------------------------------

export function Finance({ data }: ViewProps) {
  const fin = data.finance;
  const snaps = data.financialSnapshots ?? [];
  return (
    <div>
      <div className="card">
        <h2>Latest snapshot</h2>
        {!fin ? (
          <p className="muted">No financial snapshot yet.</p>
        ) : (
          <div className="grid">
            <div className="metric"><div className="value">{fin.cash !== undefined && fin.cash !== null ? `$${fmt(Number(fin.cash), 2)}` : "—"}</div><div className="key">Cash</div></div>
            <div className="metric"><div className="value">{fin.revenue !== undefined && fin.revenue !== null ? `$${fmt(Number(fin.revenue), 2)}` : "—"}</div><div className="key">Revenue</div></div>
            <div className="metric"><div className="value">{fin.expenses !== undefined && fin.expenses !== null ? `$${fmt(Number(fin.expenses), 2)}` : "—"}</div><div className="key">Expenses</div></div>
            <div className="metric"><div className="value">{(fin.runway_months !== undefined && fin.runway_months !== null) ? String(fin.runway_months) : "—"}</div><div className="key">Runway (mo)</div></div>
          </div>
        )}
      </div>
      <div className="card">
        <h2>History</h2>
        {snaps.length === 0 ? (
          <p className="muted">No snapshot history.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Period</th><th>Cash</th><th>Revenue</th><th>Expenses</th><th>Notes</th></tr>
            </thead>
            <tbody>
              {snaps.map((s, i) => (
                <tr key={i}>
                  <td className="mono">{String(s.period)}</td>
                  <td className="mono">${fmt(Number(s.cash ?? 0), 2)}</td>
                  <td className="mono">${fmt(Number(s.revenue ?? 0), 2)}</td>
                  <td className="mono">${fmt(Number(s.expenses ?? 0), 2)}</td>
                  <td className="muted">{String(s.notes ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h2>AI cost</h2>
        <div className="row">
          <div className="metric"><div className="value">${fmt(data.budget.spentToday, 2)}</div><div className="key">Today</div></div>
          <div className="metric"><div className="value">${fmt(data.budget.spentThisMonth, 2)}</div><div className="key">This month</div></div>
          <div className="metric"><div className="value">{fmt(data.budget.tokensToday)}</div><div className="key">Tokens today</div></div>
          <div className="metric"><div className="value">{fmt(data.budget.tokensThisMonth)}</div><div className="key">Tokens month</div></div>
        </div>
      </div>
    </div>
  );
}

// ---- Decisions & Risks ------------------------------------------------------

export function Decisions({ data }: ViewProps) {
  const decisions = data.decisions ?? [];
  const risks = data.risks ?? [];
  return (
    <div>
      <div className="card">
        <h2>Decisions</h2>
        {decisions.length === 0 ? (
          <p className="muted">No decisions yet.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Title</th><th>Status</th><th>Category</th><th>Confidence</th><th>Updated</th></tr>
            </thead>
            <tbody>
              {decisions.map((d, i) => (
                <tr key={i}>
                  <td>{String(d.title ?? "")}</td>
                  <td><Badge tone={String(d.status) === "DONE" ? "ok" : "warn"}>{String(d.status)}</Badge></td>
                  <td className="mono">{String(d.category ?? "")}</td>
                  <td className="mono">{d.confidence !== undefined && d.confidence !== null ? `${Math.round(Number(d.confidence) * 100)}%` : "—"}</td>
                  <td className="mono muted">{timeAgo(String(d.updated_at ?? ""))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h2>Open risks</h2>
        {risks.length === 0 ? (
          <p className="muted">No open risks.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Risk</th><th>Level</th><th>Status</th><th>Updated</th></tr>
            </thead>
            <tbody>
              {risks.map((r, i) => (
                <tr key={i}>
                  <td>{String(r.description ?? r.title ?? "")}</td>
                  <td><Badge tone={String(r.level ?? "") === "HIGH" || String(r.level ?? "") === "CRITICAL" ? "fail" : String(r.level ?? "") === "MEDIUM" ? "warn" : undefined}>{String(r.level ?? "")}</Badge></td>
                  <td><Badge>{String(r.status ?? "")}</Badge></td>
                  <td className="mono muted">{timeAgo(String(r.updated_at ?? ""))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---- Catalog (products/projects/engineering/marketing) ----------------------

export function Catalog({ data }: ViewProps) {
  const projects = data.projects ?? [];
  const engineering = data.engineering ?? [];
  const marketing = data.marketing ?? [];
  const objectives = data.objectives ?? [];
  return (
    <div>
      <div className="card">
        <h2>Objectives</h2>
        {objectives.length === 0 ? <p className="muted">None.</p> : objectives.map((o, i) => (
          <div key={i} className="metric" style={{ marginBottom: 8 }}>
            <div className="value" style={{ fontSize: 14 }}>{String(o.title ?? "")}</div>
            <div className="key">{String(o.status ?? "")} · priority {String(o.priority ?? "")}</div>
          </div>
        ))}
      </div>
      <div className="card">
        <h2>Projects</h2>
        {projects.length === 0 ? <p className="muted">No projects.</p> : (
          <table>
            <thead>
              <tr><th>Name</th><th>Status</th><th>Priority</th><th>Target</th></tr>
            </thead>
            <tbody>
              {projects.map((p, i) => (
                <tr key={i}>
                  <td>{String(p.name ?? "")}</td>
                  <td><Badge tone={String(p.status) === "ACTIVE" ? "ok" : "warn"}>{String(p.status ?? "")}</Badge></td>
                  <td>{String(p.priority ?? "")}</td>
                  <td className="mono muted">{String(p.target_date ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h2>Engineering issues</h2>
        {engineering.length === 0 ? <p className="muted">None.</p> : (
          <table>
            <thead>
              <tr><th>Issue</th><th>Severity</th><th>Status</th></tr>
            </thead>
            <tbody>
              {engineering.map((e, i) => (
                <tr key={i}>
                  <td>{String(e.title ?? e.description ?? "")}</td>
                  <td><Badge tone={String(e.severity ?? "") === "HIGH" ? "fail" : "warn"}>{String(e.severity ?? "")}</Badge></td>
                  <td><Badge>{String(e.status ?? "")}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h2>Marketing campaigns</h2>
        {marketing.length === 0 ? <p className="muted">None.</p> : (
          <table>
            <thead>
              <tr><th>Name</th><th>Channel</th><th>Budget</th><th>Status</th></tr>
            </thead>
            <tbody>
              {marketing.map((m, i) => (
                <tr key={i}>
                  <td>{String(m.name ?? "")}</td>
                  <td className="mono">{String(m.channel ?? "")}</td>
                  <td className="mono">${fmt(Number(m.budget ?? 0), 0)}</td>
                  <td><Badge>{String(m.status ?? "")}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
