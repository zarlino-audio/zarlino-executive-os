// Typed client for the Executive OS API. Login exchanges the founder
// username/password for a session token, stored in localStorage and sent as
// Authorization: Bearer on every request.

export const TOKEN_KEY = "exec_os_token";

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body !== undefined && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  // Hard 25s timeout so a hanging request can't freeze the console.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(path, { ...init, headers, signal: controller.signal });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) msg = body.error;
      } catch {
        /* non-JSON error body */
      }
      // Expired session: bounce to the login gate everywhere at once.
      if (res.status === 401 && path !== "/api/auth/login") {
        clearToken();
        window.dispatchEvent(new Event("exec-os-unauthorized"));
        msg = "Session expired — please sign in again.";
      }
      throw new Error(msg);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("Request timed out — check your connection and retry.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  health: () => request<Health>("/api/health"),

  // Username/password login returns a session token, which is then sent as
  // Authorization: Bearer for every subsequent request.
  login: (username: string, password: string) =>
    request<{ ok: boolean; token: string; expiresAt: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () =>
    request<{ ok: boolean }>("/api/auth/logout", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean; note: string }>("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  overview: () => request<Overview>("/api/executive/overview"),
  controlExecutive: (patch: {
    paused?: boolean;
    spendingDisabled?: boolean;
    deploymentsDisabled?: boolean;
    delegateMode?: boolean;
    fullAccess?: boolean;
    autonomyMode?: string;
  }) =>
    request<{ ok: boolean; state: Record<string, unknown> }>("/api/executive/control", {
      method: "POST",
      body: JSON.stringify(patch),
    }),

  doctorRun: (autoFix: boolean) =>
    request<DoctorReport>("/api/doctor/run", {
      method: "POST",
      body: JSON.stringify({ autoFix, trigger: "console" }),
    }),

  doctorLogs: () => request<{ logs: DoctorLog[] }>("/api/doctor/logs"),

  maintenance: () =>
    request<Record<string, unknown>>("/api/maintenance/run", {
      method: "POST",
      body: JSON.stringify({}),
    }),

  autoTasks: () =>
    request<{ ok: boolean; started: number }>("/api/autotasks/run", {
      method: "POST",
      body: JSON.stringify({}),
    }),

  chat: (message: string, sessionId: string, model?: string) =>
    request<ChatReply>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message, sessionId, model }),
    }),
  chatSessions: (opts: { limit?: number; offset?: number } = {}) =>
    request<{ sessions: ChatSession[]; hasMore: boolean; total: number }>(
      `/api/chat/sessions?limit=${opts.limit ?? 40}&offset=${opts.offset ?? 0}`,
    ),
  chatMessages: (sessionId: string, opts: { limit?: number; before?: string } = {}) =>
    request<{ messages: ChatMessage[]; hasMore: boolean; total: number; title: string | null }>(
      `/api/chat/messages?sessionId=${encodeURIComponent(sessionId)}&limit=${opts.limit ?? 80}` +
        (opts.before ? `&before=${encodeURIComponent(opts.before)}` : ""),
    ),
  /** Kick off a streaming reply; returns the stream id to consume via chatSse. */
  chatStreamStart: (message: string, sessionId: string, opts: { model?: string; attachments?: ChatAttachment[] } = {}) =>
    request<{ ok: boolean; streamId: string; sessionId: string; model: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message, sessionId, stream: true, model: opts.model, attachments: opts.attachments }),
    }),
  /** Re-run the last assistant turn (the server truncates it first). */
  chatRegenerate: (sessionId: string, model?: string) =>
    request<{ ok: boolean; streamId: string; sessionId: string }>("/api/chat/regenerate", {
      method: "POST",
      body: JSON.stringify({ sessionId, model, stream: true }),
    }),
  /** Really cancel the in-flight provider call for a stream (gap 6). */
  chatStop: (streamId: string) =>
    request<{ ok: boolean; stopped: boolean }>("/api/chat/stop", {
      method: "POST",
      body: JSON.stringify({ streamId }),
    }),
  /** Thumbs feedback on an assistant message (gap 12). */
  chatRate: (messageId: string, rating: number) =>
    request<{ ok: boolean; rating: number }>("/api/chat/rate", {
      method: "POST",
      body: JSON.stringify({ messageId, rating }),
    }),
  /** Rename a conversation (gap 16). */
  chatRename: (sessionId: string, title: string) =>
    request<{ ok: boolean; title: string }>("/api/chat/rename", {
      method: "POST",
      body: JSON.stringify({ sessionId, title }),
    }),
  /** Drop a message and everything after it — edit-and-resend (gap 5). */
  chatTruncate: (sessionId: string, messageId: string) =>
    request<{ ok: boolean; removed: number }>("/api/chat/truncate", {
      method: "POST",
      body: JSON.stringify({ sessionId, messageId }),
    }),
  clearChat: (sessionId: string) =>
    request<{ ok: boolean }>("/api/chat/clear", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    }),
  /** Upload an attachment (base64) — used by the chat composer (gap 11). */
  uploadFile: (name: string, mime: string, dataBase64: string) =>
    request<{ ok: boolean; fileId: string; kind: string; sizeBytes: number }>("/api/files", {
      method: "POST",
      body: JSON.stringify({ name, mime, dataBase64 }),
    }),

  tasks: () => request<{ tasks: Task[] }>("/api/tasks"),
  createTask: (title: string, description?: string, priority?: string) =>
    request<{ ok: boolean; id: string }>("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ title, description, priority }),
    }),
  updateTask: (id: string, patch: { status?: string; priority?: string }) =>
    request<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  approvals: () => request<{ approvals: Approval[] }>("/api/approvals"),
  decideApproval: (id: string, decision: string, note?: string) =>
    request<{ ok: boolean; status: string }>("/api/approvals/decide", {
      method: "POST",
      body: JSON.stringify({ id, decision, note }),
    }),

  settings: () => request<Settings>("/api/settings"),
  saveSettings: (overrides: BudgetOverrides) =>
    request<{ ok: boolean; budgetOverrides: BudgetOverrides }>("/api/settings", {
      method: "POST",
      body: JSON.stringify(overrides),
    }),

  productivityReport: () => request<ProductivityReport>("/api/productivity/report"),
  productivityBudget: () => request<{ budgets: BudgetStatusEntry[] }>("/api/productivity/budget"),
  productivityAssignments: () => request<{ assignments: Assignment[] }>("/api/productivity/assignments"),
  productivityAssign: (taskId: string, roleId?: string) =>
    request<{ ok: boolean; assignmentId: string }>("/api/productivity/assign", {
      method: "POST",
      body: JSON.stringify({ taskId, roleId }),
    }),
  productivityOptimize: () =>
    request<{ ok: boolean; events: OptimizationEvent[]; summary: { applied: number; recommended: number } }>("/api/productivity/optimize", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  productivityContradictions: () =>
    request<{ contradictions: Contradiction[]; open: number }>("/api/productivity/contradictions"),
  productivityDetect: () =>
    request<{ ok: boolean; found: ContradictionDetection[]; created: number }>("/api/productivity/contradictions/detect", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  productivityResolve: (id: string, resolution: string, status: string) =>
    request<{ ok: boolean; id: string; status: string }>(`/api/productivity/contradictions/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      body: JSON.stringify({ resolution, status }),
    }),
  productivityMetrics: () => request<{ metrics: ProductivityMetric[] }>("/api/productivity/metrics"),

  // Review queue (remote operator vetting of sound / UI / artifacts).
  reviews: (status?: string) => request<{ reviews: ReviewItem[] }>(`/api/reviews${status ? `?status=${status}` : ""}`),
  createReview: (kind: string, title: string, description: string, payload: Record<string, unknown>) =>
    request<{ ok: boolean; id: string }>("/api/reviews", {
      method: "POST",
      body: JSON.stringify({ kind, title, description, payload }),
    }),
  decideReview: (id: string, status: string, note: string) =>
    request<{ ok: boolean; id: string; status: string }>(`/api/reviews/${encodeURIComponent(id)}/decide`, {
      method: "POST",
      body: JSON.stringify({ status, note }),
    }),
  getFile: (id: string) => request<{ id: string; name: string; mime?: string; kind?: string; data_base64?: string; size_bytes?: number }>(`/api/files/${encodeURIComponent(id)}`),

  // Perceptual Intelligence (external human ear network, test registry, gates).
  perceptualReport: () => request<PerceptualKpi>("/api/perceptual/report"),
  perceptualTests: () => request<{ tests: PerceptualTest[] }>("/api/perceptual/tests"),
  createPerceptualTest: (t: {
    productId: string;
    title: string;
    testType?: string;
    hypothesis?: string;
    objective?: string;
    protocol?: string;
    sampleSizeTarget?: number;
    blinding?: string;
    tier?: string;
  }) =>
    request<{ ok: boolean; id: string }>("/api/perceptual/tests", {
      method: "POST",
      body: JSON.stringify(t),
    }),
  patchPerceptualTest: (id: string, patch: { status?: string; protocol?: string }) =>
    request<{ ok: boolean }>(`/api/perceptual/tests/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  perceptualResults: (testId: string) =>
    request<{ results: PerceptualResult[] }>(`/api/perceptual/tests/${encodeURIComponent(testId)}/results`),
  recordPerceptualResult: (testId: string, r: {
    evaluatorId: string;
    responses: Record<string, unknown>;
    attentionChecksPassed?: number;
    attentionChecksTotal?: number;
    selfConfidence?: number;
    completionMs?: number;
  }) =>
    request<{ ok: boolean; id: string; status: string }>(`/api/perceptual/tests/${encodeURIComponent(testId)}/results`, {
      method: "POST",
      body: JSON.stringify(r),
    }),
  perceptualAnalysis: (testId: string) =>
    request<{ aggregation: TestAggregation; knowledgeDraft: Record<string, unknown> }>(`/api/perceptual/tests/${encodeURIComponent(testId)}/analysis`),
  perceptualEvaluators: () => request<{ evaluators: PerceptualEvaluator[] }>("/api/perceptual/evaluators"),
  registerEvaluator: (e: {
    name: string;
    actorType?: string;
    expertise?: string;
    genres?: string[];
    experienceLevel?: string;
    compensationProfile?: string;
    conflicts?: string[];
  }) =>
    request<{ ok: boolean; id: string }>("/api/perceptual/evaluators", {
      method: "POST",
      body: JSON.stringify(e),
    }),
  deleteEvaluator: (id: string) =>
    request<{ deleted: boolean }>(`/api/perceptual/evaluators/${encodeURIComponent(id)}`, { method: "DELETE" }),
  perceptualValidations: () => request<{ validations: ProductValidation[] }>("/api/perceptual/validations"),
  setValidation: (v: {
    productId: string;
    stage?: string;
    engineering?: string;
    measurement?: string;
    perceptual?: string;
    workflow?: string;
    commercial?: string;
    governance?: string;
    decision?: string;
    decisionNote?: string;
  }) =>
    request<{ ok: boolean; validation: ProductValidation }>("/api/perceptual/validations", {
      method: "POST",
      body: JSON.stringify(v),
    }),
  perceptualKnowledge: () => request<{ knowledge: PerceptualKnowledge[] }>("/api/perceptual/knowledge"),
  addKnowledge: (k: {
    productCategory: string;
    musicalContext?: string;
    desiredOutcome?: string;
    observations?: string[];
    confidence?: number;
    sampleSize?: number;
    testProtocol?: string;
    evidenceTier?: string;
  }) =>
    request<{ ok: boolean; id: string }>("/api/perceptual/knowledge", {
      method: "POST",
      body: JSON.stringify(k),
    }),
  deleteKnowledge: (id: string) =>
    request<{ deleted: boolean }>(`/api/perceptual/knowledge/${encodeURIComponent(id)}`, { method: "DELETE" }),
  perceptualFailures: () => request<{ failures: FailureAnalysis[] }>("/api/perceptual/failures"),
  recordFailure: (f: { productId: string; failureClass: string; title: string; description?: string; lessons?: string[] }) =>
    request<{ ok: boolean; id: string; failureClass: string }>("/api/perceptual/failures", {
      method: "POST",
      body: JSON.stringify(f),
    }),

  // Deep data bundle (one bounded request powers every console view).
  dataAll: () => request<DataBundle>("/api/data/all"),

  // Domain mutations.
  updateGate: (id: string, status: string) =>
    request<{ ok: boolean }>(`/api/pipeline/gates/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
  addCalendarEvent: (title: string, startAt: string, endAt?: string, allDay?: boolean) =>
    request<{ ok: boolean }>("/api/calendar", {
      method: "POST",
      body: JSON.stringify({ title, startAt, endAt, allDay }),
    }),
  deleteCalendarEvent: (id: string) => request<{ deleted: boolean }>(`/api/calendar/${encodeURIComponent(id)}`, { method: "DELETE" }),
  addNote: (title: string, body: string) =>
    request<{ ok: boolean }>("/api/notes", { method: "POST", body: JSON.stringify({ title, body }) }),
  deleteNote: (id: string) => request<{ deleted: boolean }>(`/api/notes/${encodeURIComponent(id)}`, { method: "DELETE" }),
  addReminder: (title: string, dueAt: string) =>
    request<{ ok: boolean }>("/api/reminders", { method: "POST", body: JSON.stringify({ title, dueAt }) }),
  markReminderDone: (id: string) => request<{ ok: boolean }>(`/api/reminders/${encodeURIComponent(id)}/done`, { method: "POST", body: JSON.stringify({}) }),
  deleteReminder: (id: string) => request<{ deleted: boolean }>(`/api/reminders/${encodeURIComponent(id)}`, { method: "DELETE" }),
  addContact: (name: string, role: string, company: string, email: string) =>
    request<{ ok: boolean }>("/api/contacts", { method: "POST", body: JSON.stringify({ name, role, company, email }) }),
  continueRun: (id: string) => request<{ ok: boolean; id: string }>(`/api/agents/runs/${encodeURIComponent(id)}/continue`, { method: "POST", body: JSON.stringify({}) }),

  exportSnapshot: () => request<{ ok: boolean; snapshot: unknown }>("/api/export"),
};

// ---- Deep data bundle types -----------------------------------------------

export interface DataBundle {
  generatedAt: string;
  state: {
    status: string;
    autonomy_mode: string;
    paused: number;
    spending_disabled: number;
    deployments_disabled: number;
    delegate_mode: number;
    full_access: number;
  } | null;
  counters: Record<string, number>;
  products: Array<{ id: string; name: string; category?: string; status: string; version?: string; price?: number }>;
  productStatus: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
  objectives: Array<Record<string, unknown>>;
  tasks: Task[];
  decisions: Array<Record<string, unknown>>;
  risks: Array<Record<string, unknown>>;
  engineering: Array<Record<string, unknown>>;
  marketing: Array<Record<string, unknown>>;
  doctrine: Array<Record<string, unknown>>;
  policies: Array<Record<string, unknown>>;
  memories: Array<Record<string, unknown>>;
  pipeline: Array<Record<string, unknown>>;
  persons: Array<Record<string, unknown>>;
  finance: Record<string, unknown> | null;
  financialSnapshots: Array<Record<string, unknown>>;
  calendar: Array<Record<string, unknown>>;
  notes: Array<Record<string, unknown>>;
  reminders: Array<Record<string, unknown>>;
  contacts: Array<Record<string, unknown>>;
  audit: Array<Record<string, unknown>>;
  files: Array<{ id: string; name: string; kind?: string; mime?: string; sizeBytes?: number; created_at: string }>;
  localTasks: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  toolExecutions: Array<Record<string, unknown>>;
  metrics: Array<Record<string, unknown>>;
  workstreams: Array<Record<string, unknown>>;
  budget: {
    daily: number;
    monthly: number;
    envDaily?: number;
    envMonthly?: number;
    spentToday: number;
    spentThisMonth: number;
    tokensToday: number;
    tokensThisMonth: number;
    overrides: BudgetOverrides;
  };
  founderBrief: {
    overdueReminders: Array<Record<string, unknown>>;
    pendingApprovals: Array<Record<string, unknown>>;
    openContradictions: Array<Record<string, unknown>>;
    topRisks: Array<Record<string, unknown>>;
    pendingReviews: ReviewItem[];
    generatedAt: string;
  };
  reviews: ReviewItem[];
  perceptual: {
    tests: PerceptualTest[];
    results: PerceptualResult[];
    evaluators: PerceptualEvaluator[];
    knowledge: PerceptualKnowledge[];
    validations: ProductValidation[];
    failures: FailureAnalysis[];
    kpi: PerceptualKpi;
  };
  productivity: {
    assignments: Assignment[];
    optimizationEvents: OptimizationEvent[];
    contradictions: Contradiction[];
    budgets: BudgetStatusEntry[];
  };
  doctorLastRun: { runAt: string; trigger: string; summary: unknown } | null;
  localAgent: {
    host: string | null;
    version?: string | null;
    pid?: string | null;
    lastSeen?: string | null;
    seenAgoMs: number | null;
    online: boolean;
    pending: number;
    currentTask?: { id: string; status: string; prompt: string; updatedAt: string } | null;
  };
  links: Record<string, string>;
}

// ---- types ----------------------------------------------------------------

export interface ReviewItem {
  id: string;
  kind: string;
  title: string;
  description?: string;
  status: string;
  payload_json?: string;
  note?: string;
  source?: string;
  created_at: string;
  updated_at: string;
  decided_at?: string;
  decided_by?: string;
}

// ---- Perceptual Intelligence types -----------------------------------------

export interface PerceptualEvaluator {
  id: string;
  name: string;
  actor_type: string;
  expertise: string;
  genres_json: string;
  experience_level: string;
  reliability_score: number;
  calibration_score: number;
  reliability_by_domain_json: string;
  availability: string;
  compensation_profile: string;
  conflicts_json: string;
  test_count: number;
  created_at: string;
  updated_at: string;
}

export interface PerceptualTest {
  id: string;
  product_id: string;
  title: string;
  hypothesis: string;
  objective: string;
  test_type: string;
  protocol: string;
  stimuli_json: string;
  conditions_json: string;
  evaluator_requirements: string;
  sample_size_target: number;
  blinding: string;
  randomization: string;
  metrics_json: string;
  acceptance_threshold: string;
  tier: string;
  status: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface PerceptualResult {
  id: string;
  test_id: string;
  evaluator_id: string;
  responses_json: string;
  completion_ms?: number;
  attention_checks_passed: number;
  attention_checks_total: number;
  self_confidence?: number;
  status: string;
  created_at: string;
}

export interface PerceptualKnowledge {
  id: string;
  product_category: string;
  musical_context: string;
  desired_outcome: string;
  observation_json: string;
  confidence: number;
  sample_size: number;
  test_protocol: string;
  source_test_id?: string;
  evidence_tier: string;
  created_at: string;
  updated_at: string;
}

export interface ProductValidation {
  product_id: string;
  stage: string;
  engineering: string;
  measurement: string;
  perceptual: string;
  workflow: string;
  commercial: string;
  governance: string;
  decision: string;
  decision_by?: string;
  decision_note?: string;
  iteration: number;
  notes_json: string;
  created_at: string;
  updated_at: string;
  evaluation?: GateEvaluation;
}

export interface GateEvaluation {
  stage: string;
  ok: boolean;
  blockers: string[];
  insufficient: string[];
  recommendation: string;
  conflict: boolean;
  cycleLimitReached: boolean;
}

export interface FailureAnalysis {
  id: string;
  product_id: string;
  failure_class: string;
  title: string;
  description: string;
  evidence_json: string;
  lesson_json: string;
  created_at: string;
  updated_at: string;
}

export interface TestAggregation {
  testId: string;
  total: number;
  accepted: number;
  rejected: number;
  weakEvidence: boolean;
  tierMinimum: number;
  tally: Array<{ choice: string; count: number }>;
  preferenceRatio: number | null;
  majorityChoice: string | null;
  correct: number;
  detectionRate: number | null;
  abxPValue: number | null;
  detected: boolean | null;
  meanConfidence: number | null;
  meanCompletionMs: number | null;
}

export interface PerceptualKpi {
  validatedProductYield: number | null;
  seriousExperiments: number;
  viableProducts: number;
  testsByStatus: Record<string, number>;
  testsByTier: Record<string, number>;
  evaluatorsActive: number;
  evidenceGaps: string[];
  avgCycleDays: number | null;
}

export interface Health {
  ok: boolean;
  service: string;
  time: string;
  schemaVersion: unknown;
  doctorLastRun: string | null;
  doctorHealthy: boolean | null;
}

export interface Overview {
  state: { status: string; mode: string };
  doctrine: unknown;
  counters: Record<string, number>;
  finance: unknown;
  products: Array<{ id: string; name: string; status: string; version: string }>;
  recentAudit: Array<{ id: string; actor: string; action: string; created_at: string }>;
  links: Record<string, string>;
}

export interface DoctorReport {
  generatedAt: string;
  trigger: string;
  autoFix: boolean;
  checks: Array<{
    id: string;
    label: string;
    severity: string;
    status: "OK" | "WARN" | "FAIL";
    detail: string;
    fixed?: string;
    action?: string;
  }>;
  summary: { total: number; ok: number; warn: number; fail: number; fixed: number };
  healthy: boolean;
}

export interface DoctorLog {
  id: string;
  trigger: string;
  auto_fix: number;
  run_at: string;
  summary_json: string;
  healthy: number;
}

export interface ChatReply {
  ok: boolean;
  reply: string;
  runId?: string;
}

export interface ChatSession {
  session_id: string;
  message_count: number;
  last_at: string;
  last_message: string;
  /** Explicit or auto-generated title (settled server-side, gap 16/26). */
  title?: string | null;
}

/** A file attached to a chat message (uploaded via /api/files first). */
export interface ChatAttachment {
  id: string;
  name: string;
  kind?: string;
  sizeBytes?: number;
}

export interface ChatMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  model?: string | null;
  /** +1 / -1 founder feedback (gap 12). */
  rating?: number | null;
  source: string;
  created_at: string;
}

/** One decoded frame of a chat stream. */
export interface ChatStreamFrame {
  text?: string;
  reasoning?: string;
  status?: string;
  tool?: string;
  cancelled?: boolean;
  error?: string | null;
}

export interface ChatSseHandlers {
  onFrame: (frame: ChatStreamFrame) => void;
  /** Fired once the stream finishes (normally, on stop, or on provider error). */
  onDone?: (info: { error?: string | null; cancelled: boolean }) => void;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Consume a streaming reply via SSE.
 *
 * - Emits every frame (text / reasoning / status / cancelled) as it arrives —
 *   this is what makes the reply type itself out instead of appearing as one
 *   lump after a long wait.
 * - Honours `event: done` (previously ignored, which left partial bubbles
 *   permanently stuck).
 * - Reconnects with `after=<frames consumed>` when the connection drops, so a
 *   flaky network loses nothing and duplicates nothing (gap 7).
 */
export async function chatSse(streamId: string, handlers: ChatSseHandlers): Promise<void> {
  let frames = 0;
  let cancelled = false;
  let lastError: string | null = null;
  const maxAttempts = 4;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (handlers.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    let finished = false;
    try {
      const res = await fetch(`/api/chat/sse?streamId=${encodeURIComponent(streamId)}&after=${frames}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
        signal: handlers.signal,
      });
      if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let event = "message";
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          for (const line of part.split("\n")) {
            if (line.startsWith("event: ")) {
              event = line.slice(7).trim();
              continue;
            }
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6);
            if (event === "done") {
              let info: { error?: string | null } = {};
              try {
                info = JSON.parse(payload) as { error?: string | null };
              } catch {
                /* empty done payload */
              }
              lastError = info.error ?? null;
              finished = true;
              continue;
            }
            if (event === "error") {
              let info: { error?: string } = {};
              try {
                info = JSON.parse(payload) as { error?: string };
              } catch {
                /* empty error payload */
              }
              throw new Error(info.error ?? "Stream failed");
            }
            let frame: ChatStreamFrame;
            try {
              frame = JSON.parse(payload) as ChatStreamFrame;
            } catch {
              frame = { text: payload }; // legacy raw-string chunk
            }
            frames++;
            if (frame.cancelled) cancelled = true;
            if (frame.error) lastError = frame.error;
            handlers.onFrame(frame);
          }
          event = "message";
        }
      }
      if (finished) {
        handlers.onDone?.({ error: lastError, cancelled });
        return;
      }
      // Stream ended without `event: done` — reconnect and resume.
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      if (attempt === maxAttempts - 1) throw err;
    }
    await sleep(250 * (attempt + 1));
  }
  handlers.onDone?.({ error: lastError, cancelled });
}

export interface Task {
  id: string;
  title: string;
  status: string;
  priority: string;
  project_id: string | null;
  created_at: string;
}

export interface Approval {
  id: string;
  title: string;
  action_label: string;
  status: string;
  priority: string;
  detail: string;
  created_at: string;
  decided_by: string | null;
  decision_note: string | null;
}

export interface BudgetOverrides {
  aiDailyBudget?: number;
  aiMonthlyBudget?: number;
  aiPerTaskBudget?: number;
  aiPerRunBudget?: number;
}

export interface Settings {
  budgetOverrides: BudgetOverrides;
  budget: BudgetOverrides;
}

export interface BudgetStatusEntry {
  scope: string;
  scopeId?: string;
  dailyBudget?: number;
  monthlyBudget?: number;
  tokensUsedToday: number;
  tokensUsedMonth: number;
  costToday: number;
  costMonth: number;
  usagePctMonth: number;
  status: "OK" | "WARN" | "OVER";
  modelTier?: string;
}

export interface Assignment {
  id: string;
  task_id: string;
  role_id?: string;
  assignee?: string;
  status: string;
  priority?: string;
  skill_matched: number;
  model_tier?: string;
  token_budget?: number;
  tokens_used: number;
  cost_estimate: number;
  cost_actual: number;
  created_at: string;
}

export interface OptimizationEvent {
  id: string;
  kind: string;
  scope: string;
  scope_id?: string;
  reason: string;
  impact_json?: string;
  applied: number;
  created_at: string;
}

export interface Contradiction {
  id: string;
  kind: string;
  subject_a?: string;
  subject_b?: string;
  claim_a?: string;
  claim_b?: string;
  status: string;
  resolution?: string;
  resolved_by?: string;
  resolved_at?: string;
  created_at: string;
}

export interface ContradictionDetection {
  kind: string;
  subjectA: string;
  subjectB: string;
  claimA: string;
  claimB: string;
}

export interface ProductivityMetric {
  id: string;
  day: string;
  tasks_done: number;
  tokens_used: number;
  cost: number;
  tasks_per_dollar: number;
  avg_tokens_per_task: number;
}

export interface ProductivityReport {
  generatedAt: string;
  budget: BudgetStatusEntry[];
  assignments: {
    total: number;
    byStatus: Record<string, number>;
    open: number;
  };
  contradictions: { open: number; resolved: number };
  optimizationEvents: { total: number; applied: number; recent: number };
  metrics: Array<{ day: string; tasksDone: number; tokensUsed: number; cost: number; tasksPerDollar: number; avgTokensPerTask: number }>;
  efficiency: Array<{ roleId: string; roleName: string; done: number; cost: number; costPerTask: number }>;
  today: { tokens: number; cost: number };
}
