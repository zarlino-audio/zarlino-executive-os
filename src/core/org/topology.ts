/**
 * Autonomous topology optimization (AOrgI §33) — the organization proposes
 * topology changes ONLY when evidence supports them, and never silently
 * changes headcount.
 *
 * Proposals are decisions for the human founder: the analyst generates
 * PROPOSED rows with rationale + evidence; a human approves/rejects; APPLIED
 * is recorded only when reality confirms the change (a real runtime registers
 * for the proposed role). Never instantiate agents merely to hit a target.
 */

import type { ExecutiveStore } from "../../db/store";
import type { OrgTopologyProposal } from "../../types";

/** Pending work a role owns while having zero live instances. */
export interface RoleEvidence {
  roleId: string;
  planSteps: number;
  tasksToVerify: number;
}

/** Real evidence: open plan steps + open verification assignments per role. */
export function pendingWorkByRole(store: ExecutiveStore): RoleEvidence[] {
  const activeRoles = store.listOrgRoles().filter((r) => r.status === "ACTIVE");
  const agents = store.listOrgAgents();
  const tasks = store.listTasks({ limit: 1000 });
  const plans = store.listOrgPlans(100);

  return activeRoles
    .filter((r) => !agents.some((a) => a.role_id === r.id && a.status === "ACTIVE"))
    .map((r) => {
      const planSteps = plans
        .flatMap((p) => store.listOrgPlanSteps(p.id))
        .filter((s) => s.owner_role === r.id && (s.status === "PENDING" || s.status === "IN_PROGRESS" || s.status === "BLOCKED")).length;
      const tasksToVerify = tasks.filter(
        (t) => t.verification_role_id === r.id && t.status !== "DONE",
      ).length;
      return { roleId: r.id, planSteps, tasksToVerify };
    })
    .filter((e) => e.planSteps > 0 || e.tasksToVerify > 0);
}

/**
 * Generate proposals from measured demand. Idempotent: never duplicates an
 * open proposal for the same role × kind.
 */
export function proposeTopology(store: ExecutiveStore): OrgTopologyProposal[] {
  const existing = store.listTopologyProposals({ limit: 200 }).filter((p) => p.status === "PROPOSED" || p.status === "APPROVED");
  const created: OrgTopologyProposal[] = [];

  // Trigger 1: a role owns pending work but has ZERO live instances.
  for (const e of pendingWorkByRole(store)) {
    if (existing.some((p) => p.role_id === e.roleId && p.kind === "instantiate")) continue;
    created.push(
      store.createTopologyProposal({
        kind: "instantiate",
        roleId: e.roleId,
        rationale: `Role '${e.roleId}' owns pending work (${e.planSteps} open plan step(s), ${e.tasksToVerify} verification task(s)) but has no live agent instance.`,
        evidence: { planSteps: e.planSteps, tasksToVerify: e.tasksToVerify },
      }),
    );
  }

  // Trigger 2: local execution queue depth exceeds the single daemon's
  // claim cadence → replicate the local-capability role (§32 bottleneck).
  const pendingLocal = store.listLocalTasks(500).filter((t) => t.status === "PENDING").length;
  if (pendingLocal > 3) {
    if (!existing.some((p) => p.role_id === "role_software_engineering" && p.kind === "replicate")) {
      created.push(
        store.createTopologyProposal({
          kind: "replicate",
          roleId: "role_software_engineering",
          rationale: `Local task queue depth ${pendingLocal} exceeds one daemon's claim cadence (§32).`,
          evidence: { pendingLocalTasks: pendingLocal },
        }),
      );
    }
  }

  return created;
}

/**
 * Reality check: an APPROVED proposal whose role now has a live instance is
 * APPLIED (recorded by the runtime, not by the analyst's imagination).
 */
export function applyTopologyDetection(store: ExecutiveStore): string[] {
  const approved = store.listTopologyProposals({ limit: 200 }).filter((p) => p.status === "APPROVED");
  const agents = store.listOrgAgents();
  const applied: string[] = [];
  for (const p of approved) {
    if (!p.role_id) continue;
    if (agents.some((a) => a.role_id === p.role_id && a.status === "ACTIVE")) {
      store.updateTopologyProposal(p.id, { status: "APPLIED", decidedBy: "runtime" });
      applied.push(p.id);
    }
  }
  return applied;
}
