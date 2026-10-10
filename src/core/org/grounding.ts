/**
 * Founder-facing operational grounding (reliability fix, 2026-10-12).
 *
 * ROOT CAUSE this fixes (observed on the real WhatsApp channel): the founder
 * asked "What's the current engineering effort towards ZTame"; the CAO voice
 * had NO retrieval step, so it answered from (a) the tiny static state digest
 * (counts + the pending-approvals list) and (b) model inference. A Zarlino
 * Source model-weights approval that happened to sit in that approvals list
 * was blended into the ZTame answer ("no checkpoint... model package"), the
 * model emitted fake asynchronous activity ("let me check and get back to
 * you", "still chasing them"), and the founder's explicit correction could
 * not survive a pronoun because NOTHING about the conversation's referent
 * was persisted. Entity identity was never resolved at all — "similar" is
 * not "same".
 *
 * This module enforces, in CODE:
 *   1. entity resolution (explicit > correction > conversation referent),
 *   2. persistence of the active referent across messages (settings),
 *   3. entity-scoped retrieval from authoritative records (objectives, tasks,
 *      remote_runs, evidence, approvals),
 *   4. a deterministic, provenance-carrying answer composed ONLY from those
 *      records (no model in the operational path),
 *   5. a fake-async-claim filter for whatever the model does produce.
 *
 * Conversation history provides conversational context; it never establishes
 * operational truth. Unknown/UNVERIFIED beats invention.
 */
import type { ExecutiveStore } from "../../db/store";

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface EntityDef {
  id: string;
  label: string;
  aliases: string[];
  kind: "product" | "project" | "system" | "channel" | "company";
}

/** Static entity registry; product entities are merged with the real product
 *  list from the store so a newly registered product is resolvable too. */
const STATIC_ENTITIES: EntityDef[] = [
  {
    id: "ent_source",
    label: "Zarlino Source",
    aliases: ["zarlino source", "zarlino-source", "source repo", "the source repo", "the source", "source", "separator model", "source model"],
    kind: "project",
  },
  { id: "ent_ztame", label: "ZTame", aliases: ["ztame", "z-tame", "ztame pro"], kind: "product" },
  { id: "ent_zscorch", label: "ZScorch", aliases: ["zscorch", "z-scorch"], kind: "product" },
  {
    id: "ent_exec_os",
    label: "Executive OS",
    aliases: ["executive os", "zarlino executive os", "executive-os"],
    kind: "system",
  },
  {
    id: "ent_website",
    label: "the website",
    aliases: ["website", "the site", "zarlinoaudio.com", "store page", "web store"],
    kind: "channel",
  },
  { id: "ent_company", label: "Zarlino Audio", aliases: ["zarlino audio", "zarlino"], kind: "company" },
];

export function listEntities(store: ExecutiveStore): EntityDef[] {
  const defs = [...STATIC_ENTITIES];
  try {
    for (const p of store.listProducts()) {
      const name = String(p.name ?? "").trim();
      if (!name) continue;
      if (defs.some((d) => d.aliases.includes(name.toLowerCase()))) continue;
      defs.push({ id: `ent_product_${String(p.id)}`, label: name, aliases: [name.toLowerCase()], kind: "product" });
    }
  } catch {
    /* products unavailable on an old schema — static list still works */
  }
  return defs;
}

export function entityById(store: ExecutiveStore, id: string | null | undefined): EntityDef | null {
  if (!id) return null;
  return listEntities(store).find((d) => d.id === id) ?? null;
}

/** Word-boundary occurrence check for one alias (all lowercase input). */
function aliasIndex(text: string, alias: string): number {
  const re = new RegExp(`(^|[^a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
  const m = re.exec(text);
  return m ? m.index : -1;
}

interface AliasHit {
  index: number;
  length: number;
  def: EntityDef;
}

/** All alias hits, longest-first at each position (so "zarlino source" wins
 *  over the shorter "zarlino"). Overlapping shorter hits are dropped. */
export function findEntities(store: ExecutiveStore, text: string): Array<{ def: EntityDef; index: number }> {
  const hay = ` ${text.toLowerCase().trim()} `;
  const hits: AliasHit[] = [];
  for (const def of listEntities(store)) {
    for (const alias of def.aliases) {
      let from = 0;
      // Up to 3 occurrences per alias is plenty for a WhatsApp message.
      for (let n = 0; n < 3; n++) {
        const idx = aliasIndex(hay.slice(from), alias);
        if (idx === -1) break;
        hits.push({ index: from + idx, length: alias.length, def });
        from = from + idx + alias.length;
      }
    }
  }
  hits.sort((a, b) => a.index - b.index || b.length - a.length);
  const kept: AliasHit[] = [];
  for (const h of hits) {
    const overlaps = kept.some((k) => h.index >= k.index && h.index < k.index + k.length);
    if (!overlaps) kept.push(h);
  }
  return kept.map((h) => ({ def: h.def, index: h.index }));
}

/** True when the text explicitly names the entity (any alias). */
export function mentionsEntity(store: ExecutiveStore, def: EntityDef, text: string): boolean {
  const hay = ` ${String(text ?? "").toLowerCase()} `;
  return def.aliases.some((a) => aliasIndex(hay, a) !== -1);
}

// ---------------------------------------------------------------------------
// Conversation referent state (persisted across messages)
// ---------------------------------------------------------------------------

export const FOUNDER_STATE_KEY = "founder_conv_state";

export interface FounderConvState {
  activeEntity: string | null;
  activeLabel: string | null;
  updatedAt: string;
  lastCorrectionAt?: string;
}

export function loadFounderState(store: ExecutiveStore): FounderConvState {
  try {
    const raw = store.getSetting(FOUNDER_STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<FounderConvState>;
      return {
        activeEntity: typeof parsed.activeEntity === "string" ? parsed.activeEntity : null,
        activeLabel: typeof parsed.activeLabel === "string" ? parsed.activeLabel : null,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
        lastCorrectionAt: typeof parsed.lastCorrectionAt === "string" ? parsed.lastCorrectionAt : undefined,
      };
    }
  } catch {
    /* fall through to a fresh state */
  }
  return { activeEntity: null, activeLabel: null, updatedAt: new Date().toISOString() };
}

export function saveFounderState(store: ExecutiveStore, state: FounderConvState): void {
  try {
    store.setSetting(FOUNDER_STATE_KEY, JSON.stringify(state));
  } catch {
    /* referent state is best-effort; a miss only loses pronoun context */
  }
}

/** Positive correction markers: the entity AFTER these is the intended one. */
const POSITIVE_CORRECTION_RE = /\b(i'?m talking about|talking about|i mean|i meant|no[,!.]? i mean|meant)\b/i;
/** Negation markers: "that's not X", "not the X" — an entity named here is
 *  being DISOWNED, not selected. */
const NEGATION_CORRECTION_RE = /\b(that'?s not|that is not|it'?s not|not the|not\b)/i;

export interface EntityResolution {
  entity: EntityDef | null;
  source: "explicit" | "correction" | "conversation_referent" | "none";
  reason: string;
}

/**
 * Resolve the entity a founder message is about.
 *   1. A correction ("I'm talking about X") sets X — the entity after the
 *      positive marker, or the last-named entity.
 *   2. A disowning correction ("that's not X") clears the referent when no
 *      positive target is named — the previous interpretation is invalidated.
 *   3. Any other explicit mention sets that entity (earliest, longest match).
 *   4. No mention: keep the active referent (pronouns like "it").
 */
export function resolveFounderEntity(store: ExecutiveStore, text: string, state: FounderConvState): EntityResolution {
  const t = String(text ?? "");
  const hits = findEntities(store, t);
  const positive = POSITIVE_CORRECTION_RE.test(t);
  const negation = NEGATION_CORRECTION_RE.test(t);

  if (hits.length > 0 && (positive || negation)) {
    if (positive) {
      const marker = POSITIVE_CORRECTION_RE.exec(t);
      const markerIndex = marker ? marker.index : -1;
      const after = hits.filter((h) => h.index >= markerIndex);
      const picked = (after.length ? after[after.length - 1] : hits[hits.length - 1])!;
      return { entity: picked.def, source: "correction", reason: `correction ("${marker?.[0] ?? "…"}") → ${picked.def.label}` };
    }
    // "That's not ZTame" / "Not Source." — disown the named entity.
    return { entity: null, source: "correction", reason: `disowning correction ("${hits.map((h) => h.def.label).join(", ")}") — previous referent invalidated` };
  }

  if (hits.length > 0) {
    return { entity: hits[0]!.def, source: "explicit", reason: `explicit mention of ${hits[0]!.def.label}` };
  }

  const active = entityById(store, state.activeEntity);
  if (active) return { entity: active, source: "conversation_referent", reason: `continuing on ${active.label}` };
  return { entity: null, source: "none", reason: "no entity named and no active referent" };
}

/** Update the persisted referent after a founder turn. */
export function noteEntityTurn(store: ExecutiveStore, resolution: EntityResolution): FounderConvState {
  const prev = loadFounderState(store);
  const now = new Date().toISOString();
  const next: FounderConvState = { ...prev, updatedAt: now };
  if (resolution.source === "correction" && !resolution.entity) {
    next.activeEntity = null;
    next.activeLabel = null;
    next.lastCorrectionAt = now;
  } else if (resolution.entity && resolution.source !== "none") {
    next.activeEntity = resolution.entity.id;
    next.activeLabel = resolution.entity.label;
    if (resolution.source === "correction") next.lastCorrectionAt = now;
  }
  saveFounderState(store, next);
  return next;
}

// ---------------------------------------------------------------------------
// Question intent
// ---------------------------------------------------------------------------

const OPERATIONAL_Q_RE =
  /\b(status|progress|update|latest|news|effort|happening|going on|working on|worked on|block(?:ed|er|ing)|done|finished|ready|release[ds]?|shipp?(?:ed|ing)?|build|pass(?:ed|es)?|fail(?:ed|s)?|where are we|what'?s happening|what is happening|any news|how'?s .* going)\b/i;

/** True when the message asks about CURRENT operations/state. */
export function isOperationalQuestion(text: string): boolean {
  return OPERATIONAL_Q_RE.test(String(text ?? ""));
}

// ---------------------------------------------------------------------------
// Entity-scoped authoritative retrieval
// ---------------------------------------------------------------------------

export interface ScopedTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  objective_id?: string;
  updated_at: string;
}

export interface EntityStatus {
  entity: string;
  entity_id: string;
  interpretation: string;
  active_objectives: Array<{ id: string; title: string; status: string; criteria: string | null }>;
  active_tasks: ScopedTask[];
  recent_done_tasks: ScopedTask[];
  blockers: Array<{ kind: "task" | "run" | "approval"; id: string; label: string; detail?: string }>;
  remote_runs: Array<{ id: string; status: string; conclusion: string | null; workflow: string; url: string | null; task_id: string | null }>;
  approvals: Array<{ id: string; label: string; status: string }>;
  latest_verified_event: { kind: "evidence" | "run" | "task"; id: string; detail: string; at: string | null } | null;
  evidence: Array<{ id: string; task_id: string; kind: string; locator: string; verified: boolean; summary: string }>;
  unknowns: string[];
  retrieved_at: string;
}

function isTerminal(status: string): boolean {
  return status === "DONE" || status === "CANCELLED";
}

/** Tasks whose title/description belongs to the entity, plus tasks linked to
 *  in-scope objectives. */
function scopedTasks(store: ExecutiveStore, def: EntityDef): { tasks: ScopedTask[]; objectives: Array<{ id: string; title: string; status: string; criteria: string | null }>; } {
  const objectives: Array<{ id: string; title: string; status: string; criteria: string | null }> = [];
  const objectiveIds = new Set<string>();
  try {
    for (const o of store.listObjectives()) {
      const text = `${o.title} ${o.description ?? ""}`;
      if (mentionsEntity(store, def, text)) {
        objectiveIds.add(o.id);
        objectives.push({ id: o.id, title: o.title, status: o.status, criteria: o.criteria_json ?? null });
      }
    }
  } catch {
    /* older schema */
  }
  const tasks: ScopedTask[] = [];
  const seen = new Set<string>();
  try {
    for (const t of store.listTasks({ limit: 500 })) {
      const linked = t.objective_id ? objectiveIds.has(t.objective_id) : false;
      const direct = mentionsEntity(store, def, `${t.title} ${t.description ?? ""}`);
      if (!linked && !direct) continue;
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      tasks.push({
        id: t.id,
        title: t.title,
        status: String(t.status),
        priority: String(t.priority),
        objective_id: t.objective_id,
        updated_at: t.updated_at,
      });
    }
  } catch {
    /* older schema */
  }
  return { tasks, objectives };
}

/**
 * Retrieve the authoritative, entity-scoped operational state. Everything
 * here comes from persisted OS records; nothing is inferred.
 */
export function retrieveEntityStatus(store: ExecutiveStore, def: EntityDef): EntityStatus {
  const { tasks, objectives } = scopedTasks(store, def);
  const taskIds = new Set(tasks.map((t) => t.id));
  const unknowns: string[] = [];

  const active = tasks.filter((t) => !isTerminal(t.status));
  const recentDone = tasks
    .filter((t) => isTerminal(t.status))
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
    .slice(0, 3);

  // Remote runs: scoped by the task links; a run whose task text names the
  // entity is NEVER counted for another entity (no cross-product bleed).
  const runs: EntityStatus["remote_runs"] = [];
  try {
    for (const r of store.listRemoteRuns(100)) {
      if (!r.task_id || !taskIds.has(r.task_id)) continue;
      runs.push({
        id: r.id,
        status: String(r.status),
        conclusion: r.conclusion ?? null,
        workflow: r.workflow_file,
        url: r.run_url ?? null,
        task_id: r.task_id,
      });
    }
  } catch {
    /* older schema */
  }

  // Blockers: BLOCKED tasks in scope + failed/unmatched scoped runs +
  // pending approvals that explicitly name the entity (never the whole queue).
  const blockers: EntityStatus["blockers"] = [];
  for (const t of active) {
    if (t.status === "BLOCKED") {
      const full = store.getTask(t.id);
      blockers.push({ kind: "task", id: t.id, label: t.title, detail: full?.close_reason ?? undefined });
    }
  }
  for (const r of runs) {
    if (r.status === "FAILED" || r.status === "UNMATCHED") {
      blockers.push({ kind: "run", id: r.id, label: `${r.workflow} ${r.status}`, detail: r.url ?? undefined });
    }
  }
  const approvals: EntityStatus["approvals"] = [];
  try {
    for (const a of store.listApprovals({ status: "PENDING", limit: 100 })) {
      const label = a.action_label ?? a.id;
      if (!mentionsEntity(store, def, label)) continue;
      approvals.push({ id: a.id, label, status: a.status });
      blockers.push({ kind: "approval", id: a.id, label, detail: "awaiting the founder" });
    }
  } catch {
    /* older schema */
  }

  // Evidence + latest verified event, from the scoped tasks only.
  const evidence: EntityStatus["evidence"] = [];
  let latest: EntityStatus["latest_verified_event"] = null;
  for (const t of tasks) {
    let items: Array<{ id: string; kind: string; locator: string; verified: boolean; summary: string; created_at: string }> = [];
    try {
      items = store.listTaskEvidence(t.id);
    } catch {
      continue;
    }
    for (const e of items) {
      evidence.push({ id: e.id, task_id: t.id, kind: e.kind, locator: e.locator, verified: e.verified, summary: e.summary });
      if (e.verified && (!latest || (e.created_at ?? "") > (latest.at ?? ""))) {
        latest = { kind: "evidence", id: e.id, detail: `${e.summary} (${e.locator})`, at: e.created_at ?? null };
      }
    }
  }
  const doneRun = runs
    .filter((r) => r.status === "COMPLETED" && r.url)
    .sort((a, b) => (b.id ?? "").localeCompare(a.id ?? ""))[0];
  if (doneRun && (!latest || latest.kind === "evidence")) {
    // A verified green run is a stronger "latest verified event" than an
    // arbitrary older evidence row; keep the newest of the two by id order.
    latest = { kind: "run", id: doneRun.id, detail: `${doneRun.workflow} completed success — ${doneRun.url}`, at: null };
  }

  if (tasks.length === 0) unknowns.push(`no task records for ${def.label} in the Executive OS`);
  if (tasks.length > 0 && active.length === 0) unknowns.push(`no active (open/in-progress) ${def.label} task right now`);
  if (active.length > 0 && runs.length === 0) unknowns.push(`no remote (GitHub Actions) run recorded for the active ${def.label} work`);

  return {
    entity: def.label,
    entity_id: def.id,
    interpretation: `current operational state of ${def.label}`,
    active_objectives: objectives.filter((o) => o.status === "ACTIVE"),
    active_tasks: active,
    recent_done_tasks: recentDone,
    blockers,
    remote_runs: runs,
    approvals,
    latest_verified_event: latest,
    evidence,
    unknowns,
    retrieved_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Deterministic answer composition (no model in the operational path)
// ---------------------------------------------------------------------------

/** Compact, provenance-carrying, WhatsApp-sized answer built ONLY from the
 *  retrieved records. Ids are short and never fabricated. */
export function composeGroundedReply(s: EntityStatus): string {
  const lines: string[] = [];
  const shortId = (id: string) => id.replace(/^(tsk|rrun|appr)_[^_]+_/, "").slice(0, 10);

  if (s.active_tasks.length === 0 && s.remote_runs.length === 0) {
    const recent = s.recent_done_tasks[0];
    lines.push(`Checked the board — nothing active on ${s.entity} right now.`);
    if (recent) lines.push(`Latest recorded: ${recent.title} (${recent.status.toLowerCase()}).`);
    lines.push(`If you expected work to be running, tell me what it is and I'll put it on the board with an owner.`);
  } else {
    const work = s.active_tasks.map((t) => `${t.title} — ${t.status.toLowerCase()} (${t.id})`).slice(0, 3);
    if (work.length) lines.push(`${s.entity}: ${s.active_tasks.length} open item${s.active_tasks.length === 1 ? "" : "s"}. ${work.join("; ")}.`);
    else lines.push(`${s.entity}: no open task records.`);
    const activeRun = s.remote_runs.find((r) => r.status === "IN_PROGRESS" || r.status === "QUEUED" || r.status === "DISPATCHED" || r.status === "CANCEL_REQUESTED");
    if (activeRun) lines.push(`Remote run ${activeRun.id} (${activeRun.workflow}) is ${activeRun.status.toLowerCase()}${activeRun.url ? ` — ${activeRun.url}` : ""}.`);
    if (s.blockers.length) {
      const b = s.blockers[0]!;
      const extra = s.blockers.length > 1 ? ` (+${s.blockers.length - 1} more)` : "";
      lines.push(`Blocker: ${b.label} [${b.kind} ${b.id}]${extra}.`);
    }
    if (s.latest_verified_event) lines.push(`Latest verified: ${s.latest_verified_event.detail}.`);
  }

  if (s.unknowns.length) lines.push(`Not on record: ${s.unknowns[0]}.`);
  return lines.slice(0, 5).join("\n");
}

// ---------------------------------------------------------------------------
// Fake asynchronous activity filter
// ---------------------------------------------------------------------------

const FAKE_ASYNC_RE =
  /\b(let me (check|look|verify|find out|dig)|i'?ll (check|look|verify|find|get back|come back|follow up)|i(?:'m| am) (checking|looking|chasing|digging|working on it|on it)|still (checking|working|chasing|looking)|get back to you|give me a (moment|sec|minute))\b/i;

/** True when the text claims in-flight checking/chasing work. */
export function containsFakeAsyncClaim(text: string): boolean {
  return FAKE_ASYNC_RE.test(String(text ?? ""));
}

/** Replace an unbacked "I'm checking…" with an honest, helpful line. */
export function sanitizeFounderReply(text: string, hasPersistedAction: boolean): string {
  const t = String(text ?? "").trim();
  if (hasPersistedAction || !containsFakeAsyncClaim(t)) return t;
  return "I can't see that one from here — name a product (ZTame, ZScorch), Source, the website or the OS and I'll pull the current state.";
}

// ---------------------------------------------------------------------------
// The founder-facing entry point
// ---------------------------------------------------------------------------

export interface GroundedReply {
  /** When true, `reply` IS the authoritative answer — do not paraphrase it. */
  grounded: boolean;
  reply: string;
  resolution: EntityResolution;
  status: EntityStatus | null;
}

/**
 * Grounded founder reply: operational questions about a resolved entity are
 * answered from OS records within this request. Non-operational messages that
 * merely name an entity still update the persisted referent.
 */
export function groundedFounderReply(store: ExecutiveStore, text: string): GroundedReply {
  const state = loadFounderState(store);
  const resolution = resolveFounderEntity(store, text, state);
  const operational = isOperationalQuestion(text);

  if (resolution.entity && resolution.source !== "none") {
    noteEntityTurn(store, resolution);
    if (operational) {
      const status = retrieveEntityStatus(store, resolution.entity);
      const reply = composeGroundedReply(status);
      recordGroundingAudit(store, {
        entity: resolution.entity.label,
        resolution_source: resolution.source,
        grounded: true,
        tasks: status.active_tasks.length,
        runs: status.remote_runs.length,
        blockers: status.blockers.length,
        unknowns: status.unknowns.length,
      });
      return { grounded: true, reply, resolution, status };
    }
    if (resolution.source === "correction") {
      // Acknowledge the correction so the founder sees it landed, and lock
      // the referent (the state was just updated above).
      recordGroundingAudit(store, {
        entity: resolution.entity.label,
        resolution_source: "correction",
        grounded: true,
        tasks: 0,
        runs: 0,
        blockers: 0,
        unknowns: 0,
        note: "correction acknowledged",
      });
      return { grounded: true, reply: `Got it — ${resolution.entity.label}.`, resolution, status: null };
    }
  } else if (resolution.source === "correction") {
    // Disowning correction with no new target: persist the invalidation.
    noteEntityTurn(store, resolution);
  }

  if (operational) {
    recordGroundingAudit(store, {
      entity: resolution.entity?.label ?? null,
      resolution_source: resolution.source,
      grounded: false,
      tasks: 0,
      runs: 0,
      blockers: 0,
      unknowns: 0,
      note: "operational question without a resolvable entity",
    });
  }
  return { grounded: false, reply: "", resolution, status: null };
}

function recordGroundingAudit(
  store: ExecutiveStore,
  detail: {
    entity: string | null;
    resolution_source: string;
    grounded: boolean;
    tasks: number;
    runs: number;
    blockers: number;
    unknowns: number;
    note?: string;
  },
): void {
  try {
    const now = new Date().toISOString();
    store.insertAudit({
      id: `aud_ground_${Math.random().toString(36).slice(2, 10)}`,
      actor: "cao_agent_01",
      action: "whatsapp.grounded_answer",
      entity_type: "founder_channel",
      entity_id: detail.entity ?? "unresolved",
      detail_json: JSON.stringify(detail),
      source: "runtime",
      created_at: now,
      updated_at: now,
    });
  } catch {
    /* diagnostics must never block the founder reply */
  }
}
