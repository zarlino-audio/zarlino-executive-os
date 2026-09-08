/**
 * Perceptual Intelligence — the external human ear network operating console.
 *
 * Implements specs/zarlino-artificial-organization.md for the founder:
 *   - product validation gates (6 evidence layers + decision matrix),
 *   - the controlled listening-test registry,
 *   - the evaluator panel (human sensor network, NOT employees),
 *   - the perceptual knowledge base (organizational memory),
 *   - the failure taxonomy,
 *   - Validated Product Yield KPIs.
 *
 * The design rule from the spec is enforced in the UI too: AI judgment is
 * never presented as equivalent to external human listening evidence.
 */
import { useState } from "react";
import {
  api,
  type DataBundle,
  type FailureAnalysis,
  type GateEvaluation,
  type PerceptualEvaluator,
  type PerceptualKnowledge,
  type PerceptualTest,
  type ProductValidation,
  type TestAggregation,
} from "../api";
import { Badge, timeAgo } from "../lib/entertain";

interface ViewProps {
  data: DataBundle;
  mutate: () => Promise<void>;
  notify: (msg: string, ok?: boolean) => void;
}

const VERDICT_TONE: Record<string, "ok" | "fail" | "warn"> = {
  PASS: "ok",
  FAIL: "fail",
  INCONCLUSIVE: "warn",
};
const LAYERS: Array<{ key: string; label: string; hint: string }> = [
  { key: "engineering", label: "Engineering", hint: "does it technically behave?" },
  { key: "measurement", label: "Measurement", hint: "what does instrumentation show?" },
  { key: "perceptual", label: "Perceptual", hint: "what do qualified listeners perceive?" },
  { key: "workflow", label: "Workflow", hint: "does it make the task easier/faster?" },
  { key: "commercial", label: "Market", hint: "will customers repeatedly use/pay?" },
  { key: "governance", label: "Governance", hint: "overrides every other signal" },
];
const TEST_TYPE_LABEL: Record<string, string> = {
  blind_preference: "Blind preference",
  abx_identification: "A/B/A-B detection",
  problem_solution: "Problem → solution",
  workflow: "Workflow",
  preference_reach: "Preference / reach",
};
const TEST_TIER_LABEL: Record<string, string> = {
  exploratory: "Exploratory",
  validation: "Validation",
  high_confidence: "High-confidence",
  commercial: "Commercial",
};
const FAILURE_LABEL: Record<string, string> = {
  discovery: "Discovery", hypothesis: "Hypothesis", dsp: "DSP", perceptual: "Perceptual",
  workflow: "Workflow", positioning: "Positioning", market: "Market", execution: "Execution",
};
const STAGES = ["prototype", "validation", "beta", "ship"];
const STATUSES = ["draft", "designed", "recruiting", "in_progress", "completed", "analyzed", "closed"];

function Verdict({ v }: { v: string }) {
  return <Badge tone={VERDICT_TONE[v] ?? "warn"}>{v === "INCONCLUSIVE" ? "?" : v}</Badge>;
}

function pct(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `${(n * 100).toFixed(0)}%`;
}

function jsonArr(s: string | undefined | null, fallback: string[] = []): string[] {
  if (!s) return fallback;
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.map(String) : fallback;
  } catch {
    return fallback;
  }
}

export function PerceptualView({ data, mutate, notify }: ViewProps) {
  const p = data.perceptual ?? { tests: [], results: [], evaluators: [], knowledge: [], validations: [], failures: [], kpi: null };
  const kpi = p.kpi;
  const [tab, setTab] = useState("gates");
  const [busy, setBusy] = useState(false);
  const products = (data.products ?? []).map((pr) => ({ id: pr.id, name: pr.name }));
  const productName = (id: string) => data.products.find((pr) => pr.id === id)?.name ?? id;
  const resultsFor = (testId: string) => p.results.filter((r) => r.test_id === testId);

  return (
    <div>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <h2>👂 Perceptual Intelligence</h2>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <Badge>yield {kpi?.validatedProductYield != null ? pct(kpi.validatedProductYield) : "—"}</Badge>
            <Badge>{kpi?.seriousExperiments ?? 0} serious tests</Badge>
            <Badge>{kpi?.evaluatorsActive ?? 0} ears active</Badge>
            <Badge tone={(kpi?.evidenceGaps?.length ?? 0) > 0 ? "warn" : "ok"}>
              {(kpi?.evidenceGaps?.length ?? 0) === 0 ? "no evidence gaps" : `${kpi?.evidenceGaps?.length} evidence gap(s)`}
            </Badge>
          </div>
        </div>
        <p className="muted">
          The external human ear network is part of decision-making infrastructure, not merely QA (spec §2). Five evidence layers
          (§3): engineering + measurement + perceptual + workflow + market. No single layer is sufficient — AI judgment is{" "}
          <strong>never</strong> equivalent to external human listening evidence.
        </p>
        <div className="row tabs" style={{ marginTop: 8 }}>
          {[
            ["gates", "Gates"],
            ["tests", "Tests"],
            ["panel", "Panel"],
            ["knowledge", "Knowledge"],
            ["failures", "Failures"],
          ].map(([id, label]) => (
            <button key={id} className={`ghost ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {kpi && kpi.avgCycleDays != null ? (
        <div className="card">
          <p className="muted">
            Avg prototype→decision cycle: <strong>{kpi.avgCycleDays.toFixed(1)} days</strong> · validated product yield ={" "}
            {kpi.viableProducts} viable / {kpi.seriousExperiments} serious experiments ={" "}
            <strong>{kpi.validatedProductYield != null ? pct(kpi.validatedProductYield) : "—"}</strong> (spec §36-37)
          </p>
        </div>
      ) : null}

      {tab === "gates" && (
        <GatesTab
          validations={p.validations}
          productName={productName}
          busy={busy}
          setBusy={setBusy}
          mutate={mutate}
          notify={notify}
        />
      )}
      {tab === "tests" && (
        <TestsTab
          tests={p.tests}
          evaluators={p.evaluators}
          products={products}
          resultsFor={resultsFor}
          productName={productName}
          busy={busy}
          setBusy={setBusy}
          mutate={mutate}
          notify={notify}
        />
      )}
      {tab === "panel" && (
        <PanelTab evaluators={p.evaluators} busy={busy} setBusy={setBusy} mutate={mutate} notify={notify} />
      )}
      {tab === "knowledge" && (
        <KnowledgeTab knowledge={p.knowledge} busy={busy} setBusy={setBusy} mutate={mutate} notify={notify} />
      )}
      {tab === "failures" && (
        <FailuresTab failures={p.failures} products={products} productName={productName} busy={busy} setBusy={setBusy} mutate={mutate} notify={notify} />
      )}
    </div>
  );
}

// ---- Gates ----------------------------------------------------------------

function GatesTab({ validations, productName, busy, setBusy, mutate, notify }: {
  validations: ProductValidation[]; productName: (id: string) => string;
  busy: boolean; setBusy: (b: boolean) => void; mutate: () => Promise<void>; notify: (m: string, ok?: boolean) => void;
}) {
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProductValidation | null>(null);

  const startEdit = (v: ProductValidation) => {
    setEditId(v.product_id);
    setDraft({ ...v });
  };
  const save = async () => {
    if (!draft || busy) return;
    setBusy(true);
    try {
      await api.setValidation({
        productId: draft.product_id,
        stage: draft.stage,
        engineering: draft.engineering,
        measurement: draft.measurement,
        perceptual: draft.perceptual,
        workflow: draft.workflow,
        commercial: draft.commercial,
        governance: draft.governance,
        decision: draft.decision,
      });
      await mutate();
      setEditId(null);
      notify("Validation gate updated — recommendation recomputed");
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), false);
    } finally {
      setBusy(false);
    }
  };

  if (validations.length === 0) {
    return (
      <div className="card">
        <p className="muted">
          No product validation gates yet. The gate exists for products you set up (or ask the agent with{" "}
          <span className="mono">perceptual.set_validation</span>). Technical completion is NOT product validation (spec §14).
        </p>
      </div>
    );
  }

  return (
    <div>
      {validations.map((v) => {
        const ev: GateEvaluation | undefined = v.evaluation;
        const isEdit = editId === v.product_id;
        return (
          <div className="card" key={v.product_id}>
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div>
                <h2 style={{ margin: 0 }}>{productName(v.product_id)}</h2>
                <p className="muted" style={{ marginTop: 2 }}>
                  stage <Badge>{v.stage}</Badge> · decision <Badge tone={v.decision === "SHIP" ? "ok" : v.decision === "KILL" ? "fail" : "warn"}>{v.decision}</Badge>
                  {v.decision_by ? ` by ${v.decision_by}` : ""} · cycle {v.iteration}/3
                </p>
              </div>
              <button className="ghost" disabled={busy} onClick={() => (isEdit ? save() : startEdit(v))}>
                {isEdit ? "Save gate" : "Edit gate"}
              </button>
            </div>
            {v.decision_note ? <p className="worker-text">{v.decision_note}</p> : null}
            <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              {LAYERS.map((l) => {
                const val = (isEdit && draft ? draft[l.key as keyof ProductValidation] : v[l.key as keyof ProductValidation]) as string;
                return (
                  <div key={l.key} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "6px 10px" }}>
                    <div className="worker-label">{l.label}</div>
                    {isEdit && draft ? (
                      <select
                        className="sel"
                        value={val}
                        onChange={(e) => setDraft({ ...draft, [l.key]: e.target.value })}
                      >
                        <option value="PASS">PASS</option>
                        <option value="FAIL">FAIL</option>
                        <option value="INCONCLUSIVE">INCONCLUSIVE</option>
                      </select>
                    ) : (
                      <Verdict v={val} />
                    )}
                    <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{l.hint}</div>
                  </div>
                );
              })}
            </div>
            {ev ? (
              <div className="worker-block" style={{ marginTop: 10 }}>
                <div className="worker-label">Decision matrix (computed — spec §26)</div>
                <p style={{ margin: 0 }}>
                  {ev.ok ? (
                    <span style={{ color: "var(--ok, #2ecc71)" }}>✅ Gate satisfied — {ev.recommendation}</span>
                  ) : ev.blockers.length > 0 ? (
                    <span style={{ color: "var(--fail, #e74c3c)" }}>⛔ Blocked — {ev.recommendation}</span>
                  ) : (
                    <span style={{ color: "var(--warn, #f1c40f)" }}>⏳ {ev.recommendation}</span>
                  )}
                  {ev.blockers.length > 0 ? <span className="muted"> (failing: {ev.blockers.join(", ")})</span> : null}
                  {ev.insufficient.length > 0 ? <span className="muted"> (insufficient: {ev.insufficient.join(", ")})</span> : null}
                  {ev.conflict ? <span className="worker-text err" style={{ display: "block", marginTop: 4 }}>⚠ Conflict: recorded decision differs from the recommendation — kept visible, never hidden (spec §24).</span> : null}
                </p>
              </div>
            ) : null}
            {isEdit && draft ? (
              <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: "wrap" }}>
                <select className="sel" value={draft.stage} onChange={(e) => setDraft({ ...draft, stage: e.target.value })}>
                  {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <select className="sel" value={draft.decision} onChange={(e) => setDraft({ ...draft, decision: e.target.value })}>
                  {["NONE", "KILL", "ITERATE", "RETEST", "BETA", "PASS", "SHIP", "ESCALATE"].map((s) => <option key={s} value={s}>{s === "NONE" ? "no decision" : s}</option>)}
                </select>
                <button className="ghost" disabled={busy} onClick={() => setEditId(null)}>Cancel</button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ---- Tests ---------------------------------------------------------------

function TestsTab({ tests, evaluators, products, resultsFor, productName, busy, setBusy, mutate, notify }: {
  tests: PerceptualTest[]; evaluators: PerceptualEvaluator[]; products: Array<{ id: string; name: string }>;
  resultsFor: (testId: string) => Array<{ status: string }>;
  productName: (id: string) => string;
  busy: boolean; setBusy: (b: boolean) => void; mutate: () => Promise<void>; notify: (m: string, ok?: boolean) => void;
}) {
  const [productId, setProductId] = useState("");
  const [title, setTitle] = useState("");
  const [testType, setTestType] = useState("blind_preference");
  const [tier, setTier] = useState("validation");
  const [sampleSize, setSampleSize] = useState(12);
  const [hypothesis, setHypothesis] = useState("");
  const [protocol, setProtocol] = useState("");
  const [blinding, setBlinding] = useState("blind");
  const [analysis, setAnalysis] = useState<Record<string, TestAggregation>>({});
  const [recordFor, setRecordFor] = useState<string | null>(null);
  const [recEval, setRecEval] = useState("");
  const [recChoice, setRecChoice] = useState("A");
  const [recConf, setRecConf] = useState(0.8);
  const [recAtt, setRecAtt] = useState("1/1");

  const create = async () => {
    if (!productId || !title.trim() || busy) return;
    setBusy(true);
    try {
      await api.createPerceptualTest({
        productId,
        title: title.trim(),
        testType,
        tier,
        sampleSizeTarget: sampleSize,
        hypothesis,
        protocol,
        blinding,
      });
      setTitle("");
      setHypothesis("");
      setProtocol("");
      await mutate();
      notify("Test registered in the registry");
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), false);
    } finally {
      setBusy(false);
    }
  };

  const advance = async (t: PerceptualTest, status: string) => {
    setBusy(true);
    try {
      await api.patchPerceptualTest(t.id, { status });
      await mutate();
      notify(`Test → ${status}`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), false);
    } finally {
      setBusy(false);
    }
  };

  const analyze = async (t: PerceptualTest) => {
    setBusy(true);
    try {
      const res = await api.perceptualAnalysis(t.id);
      setAnalysis((a) => ({ ...a, [t.id]: res.aggregation }));
      notify(res.aggregation.weakEvidence ? "Aggregation is WEAK evidence — sample below tier minimum" : "Aggregation computed");
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), false);
    } finally {
      setBusy(false);
    }
  };

  const record = async (t: PerceptualTest) => {
    if (!recEval || busy) return;
    const [passed, total] = recAtt.split("/").map((x) => Number(x.trim()) || 0);
    setBusy(true);
    try {
      const responses: Record<string, unknown> =
        t.test_type === "abx_identification"
          ? { correct: recChoice === "correct" }
          : { choice: recChoice, confidence: recConf };
      if (t.test_type !== "abx_identification") responses.confidence = recConf;
      const res = await api.recordPerceptualResult(t.id, {
        evaluatorId: recEval,
        responses,
        attentionChecksPassed: passed,
        attentionChecksTotal: total,
        selfConfidence: recConf,
      });
      setRecordFor(null);
      setRecEval("");
      await mutate();
      notify(res.status === "rejected" ? "Response REJECTED — failed attention checks (not evidence)" : "Response recorded (append-only)");
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="card">
        <h2>Register a listening test</h2>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <select className="sel" value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">product…</option>
            {products.map((pr) => (
              <option key={pr.id} value={pr.id}>{pr.name}</option>
            ))}
          </select>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Test title — what are you validating?" style={{ flex: 1, minWidth: 220 }} />
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <select className="sel" value={testType} onChange={(e) => setTestType(e.target.value)}>
            {Object.entries(TEST_TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <select className="sel" value={tier} onChange={(e) => setTier(e.target.value)}>
            {Object.entries(TEST_TIER_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <select className="sel" value={blinding} onChange={(e) => setBlinding(e.target.value)}>
            <option value="blind">blind</option>
            <option value="double_blind">double-blind</option>
            <option value="unblinded">unblinded</option>
          </select>
          <label className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            n≥<input type="number" min={1} max={1000} value={sampleSize} onChange={(e) => setSampleSize(Number(e.target.value))} style={{ width: 64 }} />
          </label>
        </div>
        <input value={hypothesis} onChange={(e) => setHypothesis(e.target.value)} placeholder="Testable claim (spec §8)…" style={{ width: "100%", marginTop: 8 }} />
        <input value={protocol} onChange={(e) => setProtocol(e.target.value)} placeholder="Protocol — stimuli, conditions, randomization, acceptance threshold…" style={{ width: "100%", marginTop: 8 }} />
        <button className="action" onClick={create} disabled={busy || !productId || !title.trim()} style={{ marginTop: 8 }}>
          Register test
        </button>
      </div>

      {tests.length === 0 ? (
        <div className="card"><p className="muted">No listening tests registered yet. Every significant perceptual decision must reference a test record — never "a few producers said it sounded good" (spec §6).</p></div>
      ) : (
        tests.map((t) => {
          const accepted = resultsFor(t.id).filter((r) => r.status !== "rejected").length;
          const agg = analysis[t.id];
          const min = TIER_MIN[tierOf(t.tier)];
          return (
            <div className="card" key={t.id}>
              <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <h2 style={{ margin: 0 }}>{t.title}</h2>
                  <p className="muted" style={{ marginTop: 4 }}>
                    <Badge>{TEST_TYPE_LABEL[t.test_type] ?? t.test_type}</Badge>{" "}
                    <Badge>{TEST_TIER_LABEL[t.tier] ?? t.tier}</Badge>{" "}
                    <Badge>{t.blinding}</Badge>{" "}
                    <Badge tone={t.status === "completed" ? "ok" : "warn"}>{t.status}</Badge>{" "}
                    {productName(t.product_id)} · {timeAgo(t.created_at)}
                  </p>
                  {t.hypothesis ? <p className="worker-text">🎯 {t.hypothesis}</p> : null}
                  {t.protocol ? <p className="muted">📋 {t.protocol}</p> : null}
                </div>
              </div>
              <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                <Badge>{accepted}/{t.sample_size_target || "?"} accepted</Badge>
                <Badge tone={accepted > 0 && accepted < min ? "warn" : "ok"}>{accepted < min ? "weak evidence" : "meets tier min"}</Badge>
                <select className="sel" value={t.status} onChange={(e) => advance(t, e.target.value)} disabled={busy}>
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <button className="ghost" disabled={busy} onClick={() => analyze(t)}>🔬 Analyze</button>
                <button className="ghost" disabled={busy} onClick={() => setRecordFor(recordFor === t.id ? null : t.id)}>
                  {recordFor === t.id ? "Close" : "＋ Record response"}
                </button>
              </div>
              {recordFor === t.id ? (
                <div className="worker-block" style={{ marginTop: 8 }}>
                  <div className="worker-label">Append-only response (cannot be edited — spec §9)</div>
                  <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <select className="sel" value={recEval} onChange={(e) => setRecEval(e.target.value)}>
                      <option value="">evaluator…</option>
                      {evaluators.filter((e) => e.availability === "active" || e.actor_type === "external_human").map((e) => (
                        <option key={e.id} value={e.id}>{e.name}{e.actor_type === "internal_agent" ? " (agent)" : ""}</option>
                      ))}
                    </select>
                    {t.test_type === "abx_identification" ? (
                      <select className="sel" value={recChoice} onChange={(e) => setRecChoice(e.target.value)}>
                        <option value="correct">correctly identified</option>
                        <option value="wrong">could NOT identify</option>
                      </select>
                    ) : (
                      <select className="sel" value={recChoice} onChange={(e) => setRecChoice(e.target.value)}>
                        <option value="A">prefers A</option>
                        <option value="B">prefers B</option>
                        <option value="neither">no preference</option>
                      </select>
                    )}
                    <input type="number" min={0} max={1} step={0.05} value={recConf} onChange={(e) => setRecConf(Number(e.target.value))} title="self confidence" style={{ width: 70 }} />
                    <input value={recAtt} onChange={(e) => setRecAtt(e.target.value)} placeholder="attention 1/1" title="attention checks passed/total" style={{ width: 90 }} />
                    <button className="action" disabled={busy || !recEval} onClick={() => record(t)}>Save</button>
                  </div>
                </div>
              ) : null}
              {agg ? (
                <div className="worker-block" style={{ marginTop: 8 }}>
                  <div className="worker-label">Structured analysis</div>
                  <p style={{ margin: 0 }}>
                    {agg.accepted} accepted · {agg.rejected} rejected (attention) ·{" "}
                    {agg.detectionRate != null ? (
                      <>detection {pct(agg.detectionRate)} — binomial p={agg.abxPValue?.toFixed(4)} →{" "}
                        <strong>{agg.detected ? "reliably detected" : "NOT reliably detected"}</strong></>
                    ) : agg.majorityChoice ? (
                      <>majority: <strong>{agg.majorityChoice}</strong> ({pct(agg.preferenceRatio)} of accepted)</>
                    ) : (
                      "no accepted responses yet"
                    )}{" "}
                    · confidence {agg.meanConfidence != null ? agg.meanConfidence.toFixed(2) : "—"}
                  </p>
                  {agg.weakEvidence ? <p className="worker-text err" style={{ margin: "4px 0 0" }}>⚠ Sample ({agg.accepted}) below {tierOf(t.tier)} tier minimum ({agg.tierMinimum}) — evidence is WEAK; do not treat as strong (spec §13).</p> : null}
                  {agg.tally.length > 0 ? <p className="muted" style={{ margin: "4px 0 0" }}>tally: {agg.tally.map((x) => `${x.choice}×${x.count}`).join(" · ")}</p> : null}
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}

function tierOf(t: string): number {
  return TIER_MIN[t] ?? TIER_MIN.validation;
}
const TIER_MIN: Record<string, number> = { exploratory: 5, validation: 12, high_confidence: 20, commercial: 30 };

// ---- Panel ---------------------------------------------------------------

function PanelTab({ evaluators, busy, setBusy, mutate, notify }: {
  evaluators: PerceptualEvaluator[];
  busy: boolean; setBusy: (b: boolean) => void; mutate: () => Promise<void>; notify: (m: string, ok?: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [expertise, setExpertise] = useState("");
  const [genres, setGenres] = useState("");
  const [exp, setExp] = useState("");

  const register = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await api.registerEvaluator({
        name: name.trim(),
        actorType: "external_human",
        expertise,
        genres: genres.split(",").map((g) => g.trim()).filter(Boolean),
        experienceLevel: exp,
      });
      setName("");
      setExpertise("");
      setGenres("");
      setExp("");
      await mutate();
      notify("Evaluator registered on the panel");
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="card">
        <h2>Register a human evaluator</h2>
        <p className="muted">External humans are <strong>evaluators</strong>, not employees or agents (spec §5). Compensation pays for qualified participation, never favorable results (spec §30).</p>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name / handle…" style={{ flex: 1, minWidth: 180 }} />
          <input value={expertise} onChange={(e) => setExpertise(e.target.value)} placeholder="Expertise (producer, mixing eng, vocal, mastering…)…" style={{ flex: 1, minWidth: 180 }} />
          <input value={genres} onChange={(e) => setGenres(e.target.value)} placeholder="Genres (comma separated)…" style={{ flex: 1, minWidth: 160 }} />
        </div>
        <input value={exp} onChange={(e) => setExp(e.target.value)} placeholder="Experience level…" style={{ width: "100%", marginTop: 8 }} />
        <button className="action" onClick={register} disabled={busy || !name.trim()} style={{ marginTop: 8 }}>Register</button>
      </div>
      {evaluators.length === 0 ? (
        <div className="card"><p className="muted">No panel members yet. The panel is a distributed perceptual measurement system — optimized for experience, listening discipline, reliability and consistency, not follower count (spec §4).</p></div>
      ) : (
        evaluators.map((e) => {
          const rel: Record<string, number> = {};
          try {
            Object.assign(rel, JSON.parse(e.reliability_by_domain_json || "{}") as Record<string, number>);
          } catch { /* ignore */ }
          const relEntries = Object.entries(rel).filter(([, v]) => typeof v === "number");
          return (
            <div className="card" key={e.id}>
              <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <h2 style={{ margin: 0 }}>{e.name}</h2>
                  <p className="muted" style={{ marginTop: 2 }}>
                    <Badge tone={e.actor_type === "external_human" ? "ok" : "warn"}>{e.actor_type.replace("_", " ")}</Badge>{" "}
                    <Badge>{e.experience_level || "experience n/a"}</Badge>{" "}
                    <Badge>{e.test_count} tests</Badge>{" "}
                    {e.availability === "active" ? <Badge tone="ok">active</Badge> : <Badge>{e.availability}</Badge>}
                  </p>
                  {e.expertise ? <p className="muted">🎯 {e.expertise}</p> : null}
                  {jsonArr(e.genres_json).length ? <p className="muted">🎵 {jsonArr(e.genres_json).join(" · ")}</p> : null}
                  {jsonArr(e.conflicts_json).length ? <p className="worker-text err">⚠ Disclosed conflicts: {jsonArr(e.conflicts_json).join("; ")} — disclosed & weighted, not silently excluded (spec §31).</p> : null}
                </div>
              </div>
              {relEntries.length > 0 ? (
                <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                  {relEntries.map(([d, v]) => (
                    <span key={d} className="badge warn">{d}: {(v * 100).toFixed(0)}%</span>
                  ))}
                </div>
              ) : (
                <p className="muted" style={{ margin: "4px 0 0" }}>Per-domain reliability accumulates after test participation — no universal "good ear" score (spec §11).</p>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

// ---- Knowledge -----------------------------------------------------------

function KnowledgeTab({ knowledge, busy, setBusy, mutate, notify }: {
  knowledge: PerceptualKnowledge[];
  busy: boolean; setBusy: (b: boolean) => void; mutate: () => Promise<void>; notify: (m: string, ok?: boolean) => void;
}) {
  const [category, setCategory] = useState("");
  const [outcome, setOutcome] = useState("");
  const [observations, setObservations] = useState("");
  const [confidence, setConfidence] = useState(0.5);
  const [sampleSize, setSampleSize] = useState(0);

  const add = async () => {
    if (!category.trim() || busy) return;
    setBusy(true);
    try {
      await api.addKnowledge({
        productCategory: category.trim(),
        desiredOutcome: outcome,
        observations: observations.split("\n").map((l) => l.trim()).filter(Boolean),
        confidence,
        sampleSize,
        evidenceTier: "perceptual",
      });
      setCategory("");
      setOutcome("");
      setObservations("");
      await mutate();
      notify("Knowledge stored in organizational memory");
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="card">
        <h2>Store perceptual knowledge</h2>
        <p className="muted">Store the underlying knowledge, not just a score: DSP behavior → perceptual consequence → musical context → producer preference (spec §27-28, §40). Raw evaluator conversation is never stored.</p>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Product category (e.g. vocal_processor)…" style={{ flex: 1, minWidth: 180 }} />
          <input value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="Desired outcome (forward vocal)…" style={{ flex: 1, minWidth: 180 }} />
          <label className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            conf <input type="number" min={0} max={1} step={0.05} value={confidence} onChange={(e) => setConfidence(Number(e.target.value))} style={{ width: 64 }} />
          </label>
          <label className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            n <input type="number" min={0} value={sampleSize} onChange={(e) => setSampleSize(Number(e.target.value))} style={{ width: 64 }} />
          </label>
        </div>
        <textarea value={observations} onChange={(e) => setObservations(e.target.value)} placeholder={"Validated observations, one per line…\n- listeners preferred moderate harmonic enhancement\n- excessive upper-mid gain reduced preference"} style={{ width: "100%", marginTop: 8, minHeight: 80 }} />
        <button className="action" onClick={add} disabled={busy || !category.trim()} style={{ marginTop: 8 }}>Store</button>
      </div>
      {knowledge.length === 0 ? (
        <div className="card"><p className="muted">No knowledge yet. Every analyzed test can be distilled here; over time this becomes the organization's proprietary evidence base — its long-term moat.</p></div>
      ) : (
        knowledge.map((k) => {
          const obs = jsonArr(k.observation_json);
          return (
            <div className="card" key={k.id}>
              <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <h2 style={{ margin: 0 }}>{k.product_category}</h2>
                  <p className="muted" style={{ marginTop: 2 }}>
                    <Badge>{k.evidence_tier} evidence</Badge>{" "}
                    <Badge>{(k.confidence * 100).toFixed(0)}% confidence</Badge>{" "}
                    <Badge>n={k.sample_size}</Badge> {k.desired_outcome ? <>· outcome: {k.desired_outcome}</> : null}{" "}
                    · {timeAgo(k.created_at)}
                  </p>
                </div>
              </div>
              {obs.length ? (
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {obs.map((o, i) => <li key={i} className="worker-text">{o}</li>)}
                </ul>
              ) : null}
              {k.test_protocol ? <p className="muted" style={{ marginTop: 4 }}>protocol: {k.test_protocol}</p> : null}
            </div>
          );
        })
      )}
    </div>
  );
}

// ---- Failures ------------------------------------------------------------

function FailuresTab({ failures, products, productName, busy, setBusy, mutate, notify }: {
  failures: FailureAnalysis[]; products: Array<{ id: string; name: string }>; productName: (id: string) => string;
  busy: boolean; setBusy: (b: boolean) => void; mutate: () => Promise<void>; notify: (m: string, ok?: boolean) => void;
}) {
  const [productId, setProductId] = useState("");
  const [failureClass, setFailureClass] = useState("perceptual");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const record = async () => {
    if (!productId || !title.trim() || busy) return;
    setBusy(true);
    try {
      await api.recordFailure({
        productId,
        failureClass,
        title: title.trim(),
        description,
        lessons: [],
      });
      setTitle("");
      setDescription("");
      await mutate();
      notify("Failure classified — engineering hours become organizational learning (spec §39)");
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="card">
        <h2>Classify a failure</h2>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <select className="sel" value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">product…</option>
            {products.map((pr) => (
              <option key={pr.id} value={pr.id}>{pr.name}</option>
            ))}
          </select>
          <select className="sel" value={failureClass} onChange={(e) => setFailureClass(e.target.value)}>
            {Object.entries(FAILURE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What failed…" style={{ flex: 1, minWidth: 200 }} />
        </div>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description / what was learned…" style={{ width: "100%", marginTop: 8 }} />
        <button className="action" onClick={record} disabled={busy || !productId || !title.trim()} style={{ marginTop: 8 }}>Record</button>
      </div>
      {failures.length === 0 ? (
        <div className="card"><p className="muted">No classified failures. When a product dies, classify WHY (discovery / hypothesis / DSP / perceptual / workflow / positioning / market / execution) — sunk cost must never influence the decision (spec §15, §39).</p></div>
      ) : (
        failures.map((f) => (
          <div className="card" key={f.id}>
            <h2 style={{ margin: 0 }}>{f.title}</h2>
            <p className="muted" style={{ marginTop: 2 }}>
              <Badge tone="fail">{FAILURE_LABEL[f.failure_class] ?? f.failure_class}</Badge>{" "}
              {productName(f.product_id)} · {timeAgo(f.created_at)}
            </p>
            {f.description ? <p>{f.description}</p> : null}
          </div>
        ))
      )}
    </div>
  );
}
