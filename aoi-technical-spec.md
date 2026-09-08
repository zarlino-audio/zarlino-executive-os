# Artificial Organizational Intelligence — Technical Specification

Companion to *Artificial Organizational Intelligence*. Same five-layer stack, same 24 chapters, same concepts — this version expresses each one as an interface, schema, protocol, or algorithm you can implement against. No concept from the source book is dropped; each subsection below maps 1:1 to a book chapter.

```
Layer 5  Collective Intelligence   — system-level metrics & tests
Layer 4  Artificial Organizations  — topology + control plane
Layer 3  Agent Interaction         — protocols between agents
Layer 2  Agentology                — agent spec / manifest
Layer 1  Agent Psychology          — single-agent runtime
```

Build bottom-up. Each layer's interfaces consume the layer below.

---

## Part I — Agent Psychology (single-agent runtime)

### 1. Reasoning

Model reasoning as an explicit, inspectable trace object — never a black box between input and output.

```
ReasoningTrace {
  agent_id: str
  task_id: str
  mode: enum[REACTIVE, DELIBERATIVE, REFLECTIVE]
  steps: [ ReasoningStep {
      step_id: str
      input_refs: [str]        # pointers into memory/context, not copies
      hypothesis: str
      evidence: [str]
      confidence: float        # 0-1, calibrated (see Ch.5)
  } ]
  final_action: Action
  trace_visibility: enum[PRIVATE, ROLE, ORG]   # who can inspect this
}
```

**Design rule:** `trace_visibility` must be ≥ ROLE for any agent whose output feeds a critic, arbiter, or governance check (Ch. 13, 18) — an uninspectable trace cannot be reviewed, so it cannot be trusted above a low autonomy level (Ch. 9).

**Mode selection heuristic:**
```
if stakes(action) < threshold_low and novelty(input) < threshold_low:
    mode = REACTIVE
elif requires_multi_step_plan(task):
    mode = DELIBERATIVE
if post_hoc_review_enabled:
    append REFLECTIVE pass over the completed trace
```

### 2. Memory

Four memory tiers, four different storage/consistency requirements:

| Tier | Scope | Consistency need | Typical backing |
|---|---|---|---|
| Working | single step, single agent | none (ephemeral) | context window |
| Episodic | single task, single agent | strong (append-only log) | per-task event log |
| Semantic | cross-task, single agent | eventual | vector store / KV store |
| Organizational | cross-agent, shared | **must be strongly consistent or explicitly versioned** | shared blackboard / DB |

```
MemoryEvent {
  event_id: str
  agent_id: str
  task_id: str
  tier: enum[WORKING, EPISODIC, SEMANTIC, ORG]
  content: any
  timestamp: datetime
  supersedes: Optional[str]   # event_id this replaces, if any
}
```

**Conflict rule:** organizational memory reads must return `(value, version)`. Any agent writing to org memory must supply the `version` it read; a version mismatch is a hard conflict, resolved by a designated arbiter role (Ch. 15), never silently overwritten. This is the direct implementation of "which memory wins" from the book.

### 3. Biases and Failure Modes

Treat known biases as testable properties, not vague warnings. Minimum test suite per agent role before deployment:

```
bias_tests = {
  "sycophancy":      inject_flawed_plan() -> expect(agent.flags_flaw == True),
  "anchoring":       vary_initial_estimate() -> expect(low_correlation(final, initial)),
  "overconfidence":  compare(stated_confidence, empirical_accuracy) -> expect(calibration_error < ε),
  "context_contamination": inject_wrong_framing() -> expect(agent.does_not_adopt_framing),
}
```

**Correlated-failure control:** if two agents share model + prompt lineage, treat their outputs as **one** data point for voting/ensemble purposes, not two independent ones. Track a `lineage_id` per agent and discount ensemble weight accordingly:
```
effective_votes = sum(1 / count_same_lineage(agent) for agent in ensemble)
```

### 4. Planning

```
Plan {
  plan_id: str
  version: int
  owner_role: str
  steps: [PlanStep { step_id, description, assigned_role, status, depends_on: [step_id] }]
  parent_plan_id: Optional[str]   # for hierarchical decomposition
}
```

Three postures map directly to control flow:

```
FIXED:        plan = make_plan(); execute(plan)                     # no revision
REACTIVE:      while not done: observe(); plan = replan(plan, obs); execute_step(plan)
HIERARCHICAL: top_plan = decompose(goal)
              for sub_goal in top_plan.steps:
                  sub_plan = owner_role(sub_goal).plan(sub_goal)     # local replanning
                  register(sub_plan, parent=top_plan)
```

**Plan-drift guard:** every deviation from the current plan version must emit a `PlanDeviationEvent(plan_id, version, step_id, reason)` to organizational memory. A reconciliation job (owned by the plan's parent role) periodically diffs deviations against the live plan and bumps `version`. No agent may act against a plan version it hasn't acknowledged.

### 5. Self-Monitoring

This is the layer everything above depends on. Minimum required signals per agent:

```
SelfMonitorState {
  calibrated_confidence: float          # see bias_tests.overconfidence
  stuck_counter: int                    # consecutive non-improving attempts
  scope_drift_score: float              # similarity of current action to role.scope
  escalation_threshold: float
}

def step(agent, state):
    result = agent.act()
    state.stuck_counter = state.stuck_counter + 1 if not improved(result) else 0
    if state.stuck_counter > STUCK_LIMIT: escalate(agent, reason="stuck")
    if state.scope_drift_score > DRIFT_LIMIT: escalate(agent, reason="scope_drift")
    if state.calibrated_confidence < state.escalation_threshold: escalate(agent, reason="low_confidence")
    return result
```

`escalate()` routes to the escalation path defined in governance (Ch. 18) — this is the single hook that connects agent-level self-monitoring to org-level control. Build it first; almost every higher-layer safety property in Part IV/V depends on this function existing and firing correctly.

---

## Part II — Agentology (agent spec / manifest)

### 6. Roles

A role is a machine-readable manifest, not a prompt string:

```yaml
role:
  name: reviewer
  scope: "evaluate outputs of role:executor against acceptance_criteria"
  authority:
    can_decide: [approve, reject, request_revision]
    must_escalate: [override_hard_constraint]
  inputs_owed:
    - executor.output
    - task.acceptance_criteria
  outputs_owed:
    - ReviewResult { verdict, rationale, blocking: bool }
```

**Validation rule:** at deploy time, statically check that every role's `inputs_owed` is produced by some other role's `outputs_owed`, and that `scope` strings across roles don't overlap without an explicit reconciliation rule. This catches the "role ambiguity" failure class before runtime.

### 7. Specialization

```
SpecializationConfig {
  role: str
  model: str
  prompt_lineage_id: str
  tool_allowlist: [str]
  knowledge_scope: [str]     # domains/corpora this agent is tuned/retrieval-scoped to
}
```

**Sizing heuristic:** start with 3 broad roles (planner / executor / reviewer). Split a role into specialists only when you can point to a measured error class that a narrower knowledge_scope or different prompt_lineage_id would independently catch — otherwise you're adding coordination cost (Ch. 10, 23) for no error-independence gain (Ch. 3).

### 8. Capabilities

```
CapabilityGrant {
  role: str
  tools: [ToolPermission { tool_name, actions: [str], rate_limit, requires_review: bool }]
  data_scopes: [str]
}
```

**Least-capability check (CI-enforceable):**
```
assert set(agent.tools_called_in_last_N_runs) ⊆ set(role.capability_grant.tools)
assert set(role.capability_grant.tools) == minimal_tools_for(role.outputs_owed)  # flag excess grants
```
`requires_review=True` on a tool is the concrete implementation of "capability as a governance lever" — wire it to the same block/approve mechanism as Ch. 13's critic authority.

### 9. Autonomy

```
enum AutonomyLevel { L0_SUGGESTS, L1_REVIEWED, L2_BOUNDED, L3_SELF_GOVERNED }

AutonomyEnvelope {
  level: AutonomyLevel
  bounds: { budget, scope, risk_threshold }     # required if level == L2
  audit_frequency: duration                     # required if level == L3
}

def promote(agent, trust_score, incident_rate):
    if trust_score > T_high and incident_rate == 0: level += 1
def demote(agent, incident):
    level = max(L0, level - severity(incident))
```

Store `AutonomyEnvelope` per (agent, capability) pair, not per agent globally — an agent can be L2 for read-only research and L0 for anything touching payments, in the same deployment.

---

## Part III — Agent Interaction (protocols)

### 10. Communication

```
Message {
  msg_id: str
  from_role: str
  to: enum[BROADCAST] | str          # role or channel
  type: enum[STATUS, REQUEST, RESULT, DEVIATION, ESCALATION]
  ref_task: str
  payload: schema_for(type)          # structured envelope, free-form body inside `payload.body`
}
```

**Anti-silent-loss rule:** define `publish_obligations` per role — a static list of message `type`s the role MUST emit on defined triggers (e.g. reviewer MUST emit `RESULT` on every completed review). Enforce with a liveness check: `alert if role has pending obligation unmet > timeout`.

### 11. Negotiation

```
NegotiationSession {
  session_id: str
  participants: [role]
  rounds: [Round { proposer, proposal, critiques: [Critique], revision }]
  max_rounds: int                 # hard bound — REQUIRED
  on_exhaustion: "arbitrate"      # must name a Ch.15/18 arbiter role
}
```

```
def negotiate(session):
    for r in range(session.max_rounds):
        proposal = current_proposer.propose()
        critiques = [p.critique(proposal) for p in participants if p != current_proposer]
        if all(c.accept for c in critiques): return proposal
        proposal = current_proposer.revise(proposal, critiques)
    return arbitrate(session)   # never falls through without resolution
```

Weighted voting variant: replace unanimity check with `sum(weight[p] for p in accepting) > threshold`, `weight` sourced from Ch.12 trust scores.

### 12. Trust

```
TrustRecord {
  subject_role: str
  capability: str                 # scoped, not global
  score: float                    # e.g. Beta(α, β) posterior mean
  last_updated: datetime
  decay_half_life: duration
}

def update_trust(record, outcome: bool):
    record.α += 1 if outcome else 0
    record.β += 0 if outcome else 1
    record.score = record.α / (record.α + record.β)

def get_trust(record, now):
    age = now - record.last_updated
    return decay(record.score, age, record.decay_half_life)
```

**Verification-cost lever:** `verification_depth = f(1 - trust_score)` — high trust → spot-check only; low trust → full re-verification. This is the mechanism that keeps review cost sub-linear as agent count grows (Ch. 23).

### 13. Criticism

```
CriticConfig {
  critic_role: str
  target_role: str
  independence: enum[SHARED_LINEAGE, DIFFERENT_PROMPT, DIFFERENT_MODEL]  # min DIFFERENT_PROMPT required
  authority: enum[COMMENT_ONLY, BLOCKING]   # must be BLOCKING for high-stakes roles
  loop_closure: "log ReviewResult.addressed: bool, alert if False after N cycles"
}
```

Reject any critic config where `independence == SHARED_LINEAGE` for a role gating an `L2`+ autonomy action — this directly encodes the book's warning that same-lineage critics reproduce blind spots.

### 14. Collaboration

```
CollaborationContract {
  task_id: str
  participants: [role]
  interface: schema                 # agreed shape of each participant's handoff — defined BEFORE work starts
  division: [SubTask { owner, depends_on: [subtask_id] }]
  shared_state_ref: str              # pointer into org memory (Ch.2) for progress visibility
}
```

Validate `interface` schema compatibility between every producer/consumer pair in `division` at contract-creation time, not at handoff time — this converts the book's "collaboration failures are interface failures" into a pre-flight check instead of a runtime surprise.

---

## Part IV — Artificial Organizations (topology + control plane)

### 15. Hierarchies

```
OrgNode {
  role: str
  parent: Optional[str]
  children: [str]
  decision_scope: str        # what this node can decide without escalating up
}
```

Bottleneck check (run against real traffic, not design-time): `if throughput(node) < arrival_rate(node.children): flag_bottleneck(node)`. Fix by parallelizing the node (multiple instances + reconciliation) or moving `decision_scope` down a level — don't just add more children under an already-saturated parent.

Compression-loss guard: require each upward summary to carry a `detail_ref` pointer back to the full unsummarized record, so a downstream agent can pull full detail on demand instead of losing it permanently at the point of summarization.

### 16. Councils

```
Council {
  members: [role]
  decision_rule: enum[UNANIMITY, MAJORITY, WEIGHTED]
  applies_to: [decision_type]        # explicit — not every decision goes to council
  deadlock_fallback: arbiter_role    # required
}
```

Route decision by type: `if decision_type in council.applies_to: use council; else: use hierarchy (Ch.15)`. This operationalizes "councils for high-stakes/ambiguous, hierarchy for high-frequency/low-stakes."

### 17. Departments

```
Department {
  name: str
  member_roles: [str]
  shared_memory_scope: str      # subset of org memory (Ch.2) visible to this dept only
  interfaces_to: [DeptInterface { other_dept, contract_schema }]
}
```

Boundary-quality metric: `cross_dept_messages / intra_dept_messages` over a trailing window. A rising ratio indicates the department boundary is misdrawn relative to actual responsibility clustering — split or merge departments accordingly.

### 18. Governance

```
GovernancePolicy {
  hard_constraints: [Constraint { predicate, applies_to: "*" | role_pattern }]
  audit_log_spec: { required_fields, retention, access_roles }
  escalation_path: [ EscalationRule { trigger, route_to } ]   # consumed by Ch.5 escalate()
  amendment_procedure: { authority_role, quorum, versioning }
}
```

```
def enforce(action, policy):
    for c in policy.hard_constraints:
        if applies(c, action.role) and c.predicate(action) == VIOLATION:
            return BLOCK   # checked before execution, at every autonomy level, no exceptions
    log(action, policy.audit_log_spec)
    return ALLOW
```

`enforce()` sits in front of every tool call (Ch. 8's `CapabilityGrant`), not just at the top of a task — this is what makes hard constraints actually hard.

### 19. Resource Allocation

```
Budget {
  role: str
  compute: quota
  tool_calls: quota
  wall_clock: duration
  elastic: bool                # can auto-adjust based on monitored outcomes
}

def adjust(budget, trust_score, incident_rate):
    if budget.elastic:
        budget.compute *= (1 + k1*trust_score - k2*incident_rate)
    budget.compute = clamp(budget.compute, floor, ceiling)
```

Contestability: expose `request_budget_increase(role, justification)` routed through the same `escalation_path` as Ch.18 — never a separate, informal channel.

---

## Part V — Collective Intelligence (system-level tests & metrics)

### 20. Emergence

Not implementable as a control — implement as an **observation pipeline**: diff observed inter-agent conventions (message patterns, routing shortcuts, informally-adopted defaults) against the designed protocol on a recurring basis.
```
def detect_emergent_convention(message_log, designed_protocol):
    observed = mine_patterns(message_log)
    return [p for p in observed if p not in designed_protocol]  # → route to governance review, Ch.18
```

### 21. Convergence

```
def convergence_test(negotiation_log):
    scores = [criterion_score(round.proposal) for round in negotiation_log.rounds]
    assert is_bounded(len(negotiation_log.rounds), max_rounds)         # Ch.11 hard cap honored
    assert is_monotonic_nondecreasing(scores, tolerance=ε)             # each round improves or holds
    assert negotiation_log.termination_reason in {"accepted", "arbitrated"}  # never "timed out silently"
```

### 22. Robustness

Chaos-test checklist (run in staging against the live topology):
```
- kill_agent(random_role)              -> assert fallback_or_redundant_path_engaged
- degrade_tool(random_tool)            -> assert graceful_degradation_mode_entered
- corrupt_output(random_agent)         -> assert containment: no unrelated role/department state changed
- suppress_signal(self_monitor)        -> assert independent detector (audit log, Ch.18) still catches it
```
Robustness score = fraction of injected failures that are contained + detected without human intervention.

### 23. Scalability

Measure, don't assume:
```
coordination_overhead(N) = messages_per_completed_task(N)   # sample at N = 5, 20, 100 agents
```
`O(N)` or better → structure scales. `O(N²)` (flat/all-to-all, Ch.10) → restructure into hierarchy/departments (Ch.15, 17) before N grows further. Also re-check Ch.18/19: governance and budget rules hand-tuned at small N are the most common actual bottleneck at scale, not agent capability — instrument them separately.

### 24. Objective Achievement

```
def evaluate_org(org, true_objective, proxy_metric):
    proxy_score = proxy_metric(org.outputs)
    true_score = human_or_ground_truth_eval(org.outputs, true_objective)
    if correlation(proxy_score_history, true_score_history) < ε:
        flag("proxy divergence — org may be optimizing the metric, not the goal")
    return true_score
```
Run this evaluation continuously (same cadence as Ch.18 audit), not once at launch — proxy divergence typically appears only after the organization has had time to adapt to whatever is being measured.

---

## Build Order (dependency-respecting)

1. `ReasoningTrace`, `MemoryEvent`, `SelfMonitorState`, bias test suite (Part I) — nothing above this works without legible reasoning and a working `escalate()` hook.
2. Role manifests + `CapabilityGrant` + `AutonomyEnvelope` (Part II) — statically validated before any agent is deployed.
3. `Message` envelope, `NegotiationSession`, `TrustRecord`, `CriticConfig`, `CollaborationContract` (Part III).
4. `OrgNode` / `Council` / `Department` topology + `GovernancePolicy.enforce()` + `Budget` (Part IV) — `enforce()` must wrap every tool call from step 2.
5. Observation/test pipelines for emergence, convergence, robustness, scalability, objective achievement (Part V) — these are monitors over the running system, not one-time gates; keep them running in production.

Each numbered chapter above is independently implementable and testable; the cross-references (Ch. X) mark the actual data/control dependencies to wire up between them.
