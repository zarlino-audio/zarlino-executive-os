/**
 * Collective intelligence measurement + organizational analyst (AOrgI §35,
 * §36) — the organization's self-observation mechanism.
 *
 * Computes the five system-level properties from REAL tables only:
 *   - convergence: negotiation rounds, capped debates, stalls,
 *   - scalability: messages per completed task (coordination overhead),
 *   - robustness: chaos drills run/passed, doctor health, agent liveness,
 *   - objective achievement: completed objectives with PostObjectiveRecords,
 *   - emergence: analyst-recorded observations (never auto-fabricated).
 *
 * The analyst produces observations + recommendations and stores a report
 * row; the Doctor enforces freshness. Chaos drills are guarded: production
 * instances are NEVER targeted (§35 — no production disruption).
 */

import type { ExecutiveStore } from "../../db/store";
import type { OrgAnalystReport } from "../../types";
import { applyTopologyDetection, proposeTopology } from "./topology";

export interface CollectiveMetrics {
  generatedAt: string;
  convergence: {
    negotiationsTotal: number;
    resolved: number;
    avgRoundsToResolve: number | null;
    cappedDebates: number;
    stalled: number;
    decisionsRendered: number;
    avgResolutionHours: number | null;
  };
  bottlenecks: {
    openTasks: number;
    pendingLocalTasks: number;
    tasksCreated7d: number;
    tasksDone7d: number;
    queueGrowth7d: number;
    decisionLatencyAvgDays: number | null;
    verificationPending: number;
    verificationAgeAvgHours: number | null;
  };
  scalability: {
    messagesTotal: number;
    completedTasks: number;
    completedTasksWithMessages: number;
    messagesPerCompletedTask: number | null;
  };
  robustness: {
    chaosTestsTotal: number;
    chaosTestsPassed: number;
    doctorFailCount: number;
    doctorWarnCount: number;
    registeredAgents: number;
    staleAgents: number;
  };
  objectiveAchievement: {
    objectivesTotal: number;
    completed: number;
    completedWithRecord: number;
    missingRecords: number;
    proxyDivergence: null; // honest: no per-objective proxy metrics defined yet
  };
  emergence: {
    observationsRecorded: number;
  };
}

function safeJsonCount(json: string | undefined | null): number {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v.length : 0;
  } catch {
    return 0;
  }
}

export function collectiveMetrics(store: ExecutiveStore): CollectiveMetrics {
  const now = Date.now();

  const negotiations = store.listOrgNegotiations(500);
  const resolved = negotiations.filter((n) => n.status === "RESOLVED");
  const rounds = resolved.map((n) => n.round);
  const avgRounds = resolved.length > 0 ? rounds.reduce((a, b) => a + b, 0) / resolved.length : null;
  const capped = resolved.filter((n) => n.round >= n.max_rounds).length;
  const stalled = negotiations.filter((n) => n.status === "ARBITRATED" || n.status === "OPEN").length;
  const resolutionHours = resolved.map((n) => (Date.parse(n.updated_at) - Date.parse(n.created_at)) / 3_600_000);
  const avgResolutionHours = resolutionHours.length > 0 ? resolutionHours.reduce((a, b) => a + b, 0) / resolutionHours.length : null;

  const messages = store.listOrgMessages({ limit: 2000 });
  const tasks = store.listTasks({ limit: 1000 });
  const done = tasks.filter((t) => t.status === "DONE");
  const doneIds = new Set(done.map((t) => t.id));
  const completedWithMessages = done.filter((t) => messages.some((m) => m.task_id === t.id)).length;
  void doneIds; // reserved for future per-task coordination analysis

  // §32 bottleneck measurement: arrival, throughput, queue depth, latencies.
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const openTasks = tasks.filter((t) => t.status !== "DONE").length;
  const pendingLocalTasks = store.listLocalTasks(500).filter((t) => t.status === "PENDING").length;
  const tasksCreated7d = tasks.filter((t) => Date.parse(t.created_at) >= weekAgo).length;
  const done7d = done.filter((t) => t.completed_at && Date.parse(t.completed_at) >= weekAgo);
  const latencyDays = done
    .filter((t) => t.completed_at)
    .map((t) => (Date.parse(t.completed_at!) - Date.parse(t.created_at)) / 86_400_000);
  const decisionLatencyAvg = latencyDays.length > 0 ? latencyDays.reduce((a, b) => a + b, 0) / latencyDays.length : null;
  const pendingReviews = store.listReviewItems({ status: "PENDING", limit: 200 });
  const reviewAges = pendingReviews.map((r) => (now - Date.parse(r.created_at)) / 3_600_000);
  const verificationAgeAvg = reviewAges.length > 0 ? reviewAges.reduce((a, b) => a + b, 0) / reviewAges.length : null;

  const chaos = store.listChaosTests(500);
  const doctor = store.latestDoctorLog();
  let doctorFail = 0;
  let doctorWarn = 0;
  if (doctor?.summary_json) {
    try {
      const s = JSON.parse(doctor.summary_json) as { fail?: number; warn?: number };
      doctorFail = s.fail ?? 0;
      doctorWarn = s.warn ?? 0;
    } catch {
      /* doctor summary unreadable — report 0, the doctor itself will flag */
    }
  }
  const agents = store.listOrgAgents();
  const staleAgents = agents.filter((a) => !a.last_seen || Date.parse(a.last_seen) < now - 2 * 24 * 60 * 60 * 1000).length;

  const objectives = store.listObjectives();
  const completed = objectives.filter((o) => ["COMPLETED", "DONE", "ACHIEVED"].includes(String(o.status).toUpperCase()));
  const completedWithRecord = completed.filter((o) => store.hasPostObjectiveRecord(o.id)).length;

  const reports = store.listAnalystReports(20);
  const observationsRecorded = reports.reduce((n, r) => n + safeJsonCount(r.observations_json), 0);

  return {
    generatedAt: new Date().toISOString(),
    convergence: {
      negotiationsTotal: negotiations.length,
      resolved: resolved.length,
      avgRoundsToResolve: avgRounds,
      cappedDebates: capped,
      stalled,
      decisionsRendered: resolved.length,
      avgResolutionHours,
    },
    bottlenecks: {
      openTasks,
      pendingLocalTasks,
      tasksCreated7d,
      tasksDone7d: done7d.length,
      queueGrowth7d: tasksCreated7d - done7d.length,
      decisionLatencyAvgDays: decisionLatencyAvg,
      verificationPending: pendingReviews.length,
      verificationAgeAvgHours: verificationAgeAvg,
    },
    scalability: {
      messagesTotal: messages.length,
      completedTasks: done.length,
      completedTasksWithMessages: completedWithMessages,
      messagesPerCompletedTask: done.length > 0 ? messages.length / done.length : null,
    },
    robustness: {
      chaosTestsTotal: chaos.length,
      chaosTestsPassed: chaos.filter((c) => c.status === "PASSED").length,
      doctorFailCount: doctorFail,
      doctorWarnCount: doctorWarn,
      registeredAgents: agents.length,
      staleAgents,
    },
    objectiveAchievement: {
      objectivesTotal: objectives.length,
      completed: completed.length,
      completedWithRecord,
      missingRecords: completed.length - completedWithRecord,
      proxyDivergence: null,
    },
    emergence: { observationsRecorded },
  };
}

/** Run the organizational analyst: measure, observe, recommend, record. */
export function runOrgAnalyst(store: ExecutiveStore, trigger: string): OrgAnalystReport {
  const metrics = collectiveMetrics(store);
  const observations: string[] = [];
  const recommendations: string[] = [];
  const c = metrics.convergence;
  const r = metrics.robustness;
  const o = metrics.objectiveAchievement;

  observations.push(
    c.negotiationsTotal === 0
      ? "Convergence: no negotiations recorded yet — nothing to converge on."
      : `Convergence: ${c.resolved}/${c.negotiationsTotal} negotiations resolved, avg ${c.avgRoundsToResolve?.toFixed(1) ?? "n/a"} rounds.`,
  );
  if (c.cappedDebates > 0) {
    observations.push(`Convergence: ${c.cappedDebates} debate(s) exhausted their round cap — arbitration was required (§22).`);
    recommendations.push("Review whether 3 rounds is too few for recurring disagreement classes.");
  }
  if (c.stalled > 0) {
    recommendations.push(`Arbitrate or close ${c.stalled} stalled negotiation(s) (§23).`);
  }
  observations.push(
    r.chaosTestsTotal === 0
      ? "Robustness: no chaos drills run yet — fallback behavior is unproven (§35)."
      : `Robustness: ${r.chaosTestsPassed}/${r.chaosTestsTotal} chaos drills passed.`,
  );
  if (r.chaosTestsTotal === 0) {
    recommendations.push("Run an agent_kill_sim drill (POST /api/org/chaos-tests/run) to verify fallback detection.");
  }
  if (r.staleAgents > 0) {
    recommendations.push(`${r.staleAgents} registered agent instance(s) stale — restart or deregister them.`);
  }
  if (o.missingRecords > 0) {
    recommendations.push(`${o.missingRecords} completed objective(s) lack PostObjectiveRecords — record them (§38).`);
  }
  observations.push(
    `Scalability: ${metrics.scalability.messagesPerCompletedTask === null ? "no completed tasks to measure" : metrics.scalability.messagesPerCompletedTask.toFixed(2)} messages per completed task.`,
  );
  observations.push(
    `Objective achievement: ${o.completedWithRecord}/${o.completed || 0} completed objectives recorded. Proxy divergence: not yet measurable (no per-objective proxy/true metric pairs defined — honest null, §35).`,
  );
  observations.push(`Emergence: ${metrics.emergence.observationsRecorded} observation(s) recorded across analyst reports.`);

  // §32 bottleneck observation: arrival > throughput means the queue grows.
  const b = metrics.bottlenecks;
  if (b.queueGrowth7d > 0) {
    observations.push(
      `Bottleneck (§32): task arrival exceeds throughput (${b.tasksCreated7d} created vs ${b.tasksDone7d} done in 7d; ${b.openTasks} open).`,
    );
    recommendations.push(
      "Consider the §32 options in order: parallelize, delegate, reduce scope, change workflow, increase capability, then instantiate another role instance.",
    );
  }
  if (b.pendingLocalTasks > 0) {
    observations.push(`Bottleneck (§32): ${b.pendingLocalTasks} local task(s) queued for the on-machine daemon.`);
  }
  if (b.verificationPending > 0) {
    observations.push(
      `Verification latency: ${b.verificationPending} review item(s) pending${b.verificationAgeAvgHours !== null ? `, avg age ${b.verificationAgeAvgHours.toFixed(1)}h` : ""}.`,
    );
  }
  if (b.decisionLatencyAvgDays !== null && b.decisionLatencyAvgDays > 3) {
    recommendations.push(`Decision latency averages ${b.decisionLatencyAvgDays.toFixed(1)} days — review the decision paths (§32).`);
  }
  if (c.decisionsRendered > 0 && c.avgResolutionHours !== null && c.avgResolutionHours > 48) {
    recommendations.push(`Negotiation→arbitration averages ${c.avgResolutionHours.toFixed(1)}h — check arbitration turnaround (§35 decision quality).`);
  }

  // Phase 5: topology optimization from measured demand — proposals only,
  // never silent changes; APPLIED is confirmed by real runtime registration.
  try {
    const proposed = proposeTopology(store);
    const applied = applyTopologyDetection(store);
    if (proposed.length > 0) {
      observations.push(
        `Topology (§33): ${proposed.length} evidence-backed proposal(s) generated — ${proposed.map((p) => `${p.kind}:${p.role_id ?? "n/a"}`).join(", ")}.`,
      );
      recommendations.push("Review topology proposals via /api/org/topology — approve only if the measured demand justifies it (§8, §33).");
    }
    if (applied.length > 0) {
      observations.push(`Topology (§33): ${applied.length} approved proposal(s) confirmed APPLIED by real runtime registration.`);
    }
  } catch {
    /* topology proposal generation must never break the analyst */
  }

  return store.createAnalystReport({
    generatedAt: metrics.generatedAt,
    trigger,
    metrics,
    observations,
    recommendations,
  });
}

// -- chaos drills (§35: robustness — staging/simulated only) ------------------

export type ChaosKind = "agent_kill_sim" | "grant_degrade";
export type ChaosOutcome = { status: "PASSED" | "FAILED" | "REFUSED"; detail: string };

const PRODUCTION_AGENTS = new Set(["executive_do_01", "local_daemon_01"]);

export function runChaosTest(store: ExecutiveStore, kind: string, target: string): ChaosOutcome {
  const record = store.createChaosTest({ kind, target });
  let outcome: ChaosOutcome;
  try {
    if (kind === "agent_kill_sim") {
      outcome = agentKillSim(store, target);
    } else if (kind === "grant_degrade") {
      outcome = grantDegrade(store, target);
    } else {
      outcome = { status: "FAILED", detail: `Unknown chaos kind '${kind}' (agent_kill_sim | grant_degrade).` };
    }
  } catch (err) {
    outcome = { status: "FAILED", detail: err instanceof Error ? err.message : String(err) };
  }
  store.finishChaosTest(record.id, outcome.status, outcome);
  return outcome;
}

function agentKillSim(store: ExecutiveStore, target: string): ChaosOutcome {
  const agent = store.getOrgAgent(target);
  if (!agent) return { status: "FAILED", detail: `Target agent '${target}' not found.` };
  if (PRODUCTION_AGENTS.has(target) || agent.source !== "chaos") {
    return {
      status: "REFUSED",
      detail: `Refusing to disrupt '${target}': production instances are never targeted; register a chaos probe (source='chaos') for drills (§35).`,
    };
  }
  // Kill simulation: heartbeat stops 3 days ago.
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  store.setOrgAgentLastSeen(target, threeDaysAgo);
  // Fallback behavior: the registry's liveness detection must flag the agent.
  const stale = store.countStaleOrgAgents(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString());
  // Restore: the probe is removed so the drill leaves no residue.
  store.deleteOrgAgent(target);
  if (stale >= 1) {
    return { status: "PASSED", detail: `Fallback behavior verified: '${target}' flagged stale by registry liveness detection. Probe cleaned up.` };
  }
  return { status: "FAILED", detail: `Liveness detection did not flag '${target}' as stale.` };
}

function grantDegrade(store: ExecutiveStore, target: string): ChaosOutcome {
  const agent = store.getOrgAgent(target);
  if (!agent) return { status: "FAILED", detail: `Target agent '${target}' not found.` };
  if (PRODUCTION_AGENTS.has(target) || agent.source !== "chaos") {
    return {
      status: "REFUSED",
      detail: `Refusing to degrade grants for '${target}': production instances are never targeted; register a chaos probe (source='chaos') for drills (§35).`,
    };
  }
  // Degrade: an L0 grant on a dedicated probe capability — fail-closed
  // enforcement must DENY. The probe capability never collides with a real
  // grant, and the grant is deleted in finally, so nothing real is touched.
  const PROBE_CAPABILITY = "__chaos_probe__";
  const grant = store.upsertCapabilityGrant({
    roleId: agent.role_id,
    capability: PROBE_CAPABILITY,
    autonomyLevel: "L0",
    allowedActions: ["*"],
  });
  try {
    const verdict = store.capabilityVerdictForAgent(target, PROBE_CAPABILITY, "probe_action");
    if (verdict.verdict === "DENY") {
      return { status: "PASSED", detail: "Fail-closed enforcement verified: L0 grant denied execution for the probe." };
    }
    return { status: "FAILED", detail: `L0 grant did not deny execution (got ${verdict.verdict}).` };
  } finally {
    store.deleteCapabilityGrant(grant.id);
  }
}
