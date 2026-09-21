/* CLOSED-LOOP GOVERNANCE - task evidence gate.
 * A task cannot reach a terminal status (DONE/CANCELLED) without verifiable
 * evidence. Origin: audit of tsk_mtkw0kj9 (marked DONE with 13 CSS classes
 * that had zero TSX references).
 *
 * Enforced in three places that all funnel through assertCanTransitionTask():
 *   1. ToolRegistry tools `projects.complete_task` / `projects.update_task`
 *   2. the /api/tasks/* route handlers
 *   3. ExecutiveStore.setTaskStatus() (transport-independent backstop)
 */
export const TERMINAL_TASK_STATUSES = ["DONE", "CANCELLED"] as const;
export type TerminalTaskStatus = (typeof TERMINAL_TASK_STATUSES)[number];

export function isTerminalTaskStatus(status: string | undefined | null): status is TerminalTaskStatus {
  return typeof status === "string" && (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

export const EVIDENCE_KINDS = ["file", "commit", "command_output", "review", "artifact", "url"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export function isEvidenceKind(value: unknown): value is EvidenceKind {
  return typeof value === "string" && (EVIDENCE_KINDS as readonly string[]).includes(value);
}

/** Minimum raw verification output accepted (a bare "ok" proves nothing). */
export const MIN_VERIFICATION_OUTPUT_CHARS = 8;
/** Minimum summary length for a verified evidence item. */
export const MIN_SUMMARY_CHARS = 8;
/** Minimum written reason when overriding the gate as founder. */
export const MIN_OVERRIDE_REASON_CHARS = 10;

export interface TaskEvidence {
  id: string;
  task_id: string;
  kind: EvidenceKind;
  locator: string;
  summary: string;
  verification_command?: string;
  verification_output?: string;
  verified: boolean;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface EvidenceInput {
  id?: unknown;
  kind?: unknown;
  locator?: unknown;
  summary?: unknown;
  verification_command?: unknown;
  verification_output?: unknown;
  verified?: unknown;
  source?: unknown;
}

export type VerificationMode = "manual" | "founder_override";

export function isVerificationMode(value: unknown): value is VerificationMode {
  return value === "manual" || value === "founder_override";
}

/** Structured, non-throwing governance failure. */
export class GovernanceError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail?: Record<string, unknown>;
  constructor(code: string, message: string, status = 400, detail?: Record<string, unknown>) {
    super(message);
    this.name = "GovernanceError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export interface EvidenceValidationSuccess {
  ok: true;
  value: {
    kind: EvidenceKind;
    locator: string;
    summary: string;
    verification_command?: string;
    verification_output?: string;
    verified: boolean;
  };
}

export interface EvidenceValidationFailure {
  ok: false;
  error: string;
  code: string;
}

export function validateEvidence(
  input: EvidenceInput,
): EvidenceValidationSuccess | EvidenceValidationFailure {
  const kind = input?.kind;
  if (!isEvidenceKind(kind)) {
    return {
      ok: false,
      code: "EVIDENCE_KIND_INVALID",
      error: `evidence kind must be one of: ${EVIDENCE_KINDS.join(", ")} (received ${JSON.stringify(kind)})`,
    };
  }
  const locator = typeof input.locator === "string" ? input.locator.trim() : "";
  if (locator.length === 0) {
    return {
      ok: false,
      code: "EVIDENCE_LOCATOR_REQUIRED",
      error: "evidence needs a non-empty locator (path, commit sha, review id, artifact id or url)",
    };
  }
  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  const verificationOutput =
    typeof input.verification_output === "string" ? input.verification_output.trim() : undefined;
  const verificationCommand =
    typeof input.verification_command === "string" ? input.verification_command.trim() : undefined;
  const claimsVerified = input.verified === true;

  if (
    (claimsVerified || kind === "command_output" || kind === "review") &&
    summary.length < MIN_SUMMARY_CHARS
  ) {
    return {
      ok: false,
      code: "EVIDENCE_SUMMARY_REQUIRED",
      error: `a ${kind} evidence item needs a summary of at least ${MIN_SUMMARY_CHARS} characters describing what it shows`,
    };
  }
  if (
    (kind === "command_output" || kind === "review") &&
    (verificationOutput ?? "").length < MIN_VERIFICATION_OUTPUT_CHARS
  ) {
    return {
      ok: false,
      code: "EVIDENCE_VERIFICATION_REQUIRED",
      error: `a ${kind} evidence item needs the RAW verification output (at least ${MIN_VERIFICATION_OUTPUT_CHARS} characters) - a claim without output is not evidence`,
    };
  }
  if (claimsVerified && !verificationCommand && !verificationOutput) {
    return {
      ok: false,
      code: "EVIDENCE_VERIFICATION_REQUIRED",
      error: "verified evidence must carry a verification_command and/or its raw verification_output",
    };
  }

  return {
    ok: true,
    value: {
      kind,
      locator,
      summary,
      verification_command: verificationCommand || undefined,
      verification_output: verificationOutput || undefined,
      verified:
        claimsVerified && Boolean(verificationOutput || verificationCommand || kind === "review"),
    },
  };
}

export interface TransitionCheckInput {
  taskId: string;
  evidenceCount: number;
  verifiedEvidenceCount?: number;
  status: string;
  mode?: VerificationMode;
  overrideReason?: string;
}

export function assertCanTransitionTask(opts: TransitionCheckInput): void {
  if (!isTerminalTaskStatus(opts.status)) return;
  const verifiedKnown = opts.verifiedEvidenceCount !== undefined;
  const verified = opts.verifiedEvidenceCount ?? 0;
  if (opts.evidenceCount > 0 && (!verifiedKnown || verified > 0)) return;
  if (
    opts.mode === "founder_override" &&
    (opts.overrideReason ?? "").trim().length >= MIN_OVERRIDE_REASON_CHARS
  ) {
    return;
  }
  const missing =
    opts.evidenceCount > 0
      ? `${opts.evidenceCount} evidence item(s) attached but none verified`
      : "no evidence attached";
  throw new GovernanceError(
    "EVIDENCE_REQUIRED",
    `Task ${opts.taskId} cannot be marked ${opts.status}: ${missing}. Attach evidence first (POST /api/tasks/evidence) - or close it with an explicit founder_override reason.`,
    409,
    {
      taskId: opts.taskId,
      status: opts.status,
      evidenceCount: opts.evidenceCount,
      verifiedEvidenceCount: verified,
      code: "EVIDENCE_REQUIRED",
    },
  );
}
