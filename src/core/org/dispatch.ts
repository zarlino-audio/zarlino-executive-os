/**
 * Dispatch policy for work sent to the local machine (the VM daemon).
 *
 * Why this exists (2026-10-04): the cloud agent learned it could answer almost
 * any task by asking the machine to "READ-ONLY inspect and report". The board
 * filled with DONE investigations that produced facts but changed nothing -
 * 30 local tasks, nearly all probes, several asking the same question twice,
 * one asking again for the same task id the day after a report already
 * answered it. Tokens burned, no file was ever edited.
 *
 * The policy has three teeth:
 *
 *   1. IDEMPOTENCE - the same prompt is never queued twice inside a week.
 *   2. ONE DISCOVERY PASS PER TASK - after a read-only pass has completed for
 *      a task, the next dispatch must be an ACTION (edit/build/run/produce).
 *      The refusal names the existing evidence so the agent can extend it
 *      instead of re-deriving it.
 *   3. AN ACT-FIRST DIRECTIVE - every prompt carries an OS preamble stating
 *      that a description of intended changes is not a deliverable, plus the
 *      prior evidence it must not re-derive.
 */
import type { ExecutiveStore } from "../../db/store";

/** Phrases that mark a dispatch as read-only reconnaissance. */
const INVESTIGATION_MARKERS = [
  "read-only",
  "read only",
  "do not modify",
  "don't modify",
  "do not change",
  "no writes",
  "no write",
  "discovery",
  "fact-find",
  "fact find",
  "inspection",
  "inspect and report",
  "probe",
  "report raw",
  "reconnaissance",
  "change-map",
  "do not apply",
  "no changes",
  "audit only",
];

/** Phrases that mark a dispatch as real work. Action wins over investigation. */
const ACTION_PATTERN =
  /\b(implement|fix|add|remove|edit|write|create|apply|change|build|refactor|migrate|deploy|commit|push|clone|install|delete|rename|run the tests|run tests|make the)\b/i;

export function isInvestigationPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const hits = INVESTIGATION_MARKERS.filter((m) => text.includes(m));
  if (hits.length === 0) return false;
  // Strip the reconnaissance wording first: "change-map" is a request for a
  // report, not a request to change something, so the phrase must not count as
  // an action verb once it has been consumed by the marker list.
  let rest = text;
  for (const m of INVESTIGATION_MARKERS) rest = rest.split(m).join(" ");
  return !ACTION_PATTERN.test(rest);
}

export interface DispatchDecision {
  ok: boolean;
  code?: "DUPLICATE" | "INVESTIGATION_LIMIT";
  error?: string;
  /** The prompt to queue (wrapped with the OS directive + prior evidence). */
  prompt: string;
  investigation: boolean;
  existingId?: string;
}

interface LocalTaskLike {
  id: string;
  task_id?: string | null;
  prompt: string;
  status: string;
  result?: string | null;
  error?: string | null;
  created_at: string;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Compare prompts by content, not byte-for-byte formatting. */
export function promptKey(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .trim()
    .slice(0, 180);
}

function recent(store: ExecutiveStore, now: Date): LocalTaskLike[] {
  const cutoff = now.getTime() - WEEK_MS;
  try {
    return (store.listLocalTasks(200) as LocalTaskLike[]).filter((t) => {
      const at = Date.parse(t.created_at ?? "");
      return Number.isFinite(at) && at >= cutoff;
    });
  } catch {
    return [];
  }
}

/**
 * Decide whether a local dispatch may be queued, and what prompt it carries.
 * Never throws: a policy failure must not break the agent loop.
 */
export function prepareDispatch(
  store: ExecutiveStore,
  input: { taskId?: string; prompt: string; now?: Date },
): DispatchDecision {
  const now = input.now ?? new Date();
  const investigation = isInvestigationPrompt(input.prompt);
  let history: LocalTaskLike[] = [];
  try {
    history = recent(store, now);
  } catch {
    history = [];
  }

  const key = promptKey(input.prompt);
  const samePrompt = history.find((t) => promptKey(t.prompt) === key);
  if (samePrompt) {
    return {
      ok: false,
      code: "DUPLICATE",
      investigation,
      existingId: samePrompt.id,
      error:
        `DUPLICATE: this exact request was already dispatched as ${samePrompt.id} (${samePrompt.status}). ` +
        `Do not re-queue it — read that result (executive.get_local_task) and act on it, or change the ask.`,
      prompt: input.prompt,
    };
  }

  if (investigation) {
    const forTask = history.filter((t) => input.taskId && t.task_id === input.taskId);
    const done = forTask.filter((t) => t.status === "DONE");
    if (done.length > 0) {
      const latest = done[done.length - 1]!;
      const gist = (latest.result ?? "").replace(/\s+/g, " ").slice(0, 260);
      return {
        ok: false,
        code: "INVESTIGATION_LIMIT",
        investigation,
        existingId: latest.id,
        error:
          `INVESTIGATION_LIMIT: a read-only pass for this task already completed (${latest.id}). ` +
          `Discovery is done — dispatch an ACTION that changes something (edit files, run the build/tests, produce the artifact). ` +
          `Existing evidence: ${gist || "(no text)"}`,
        prompt: input.prompt,
      };
    }
    const pending = forTask.find((t) => ["PENDING", "CLAIMED", "RUNNING"].includes(t.status));
    if (pending) {
      return {
        ok: false,
        code: "DUPLICATE",
        investigation,
        existingId: pending.id,
        error: `DUPLICATE: a read-only pass for this task is already queued/running (${pending.id}). Wait for it instead of asking again.`,
        prompt: input.prompt,
      };
    }
  }

  return { ok: true, investigation, prompt: wrapDispatch(input.prompt, evidenceBlock(store, input.taskId, history), investigation) };
}

/** Prior evidence for the same task — so the machine never re-derives facts. */
function evidenceBlock(store: ExecutiveStore, taskId: string | undefined, history: LocalTaskLike[]): string {
  if (!taskId) return "";
  const done = history.filter((t) => t.task_id === taskId && t.status === "DONE").slice(-2);
  if (done.length === 0) return "";
  const lines = done.map((t) => {
    const gist = (t.result ?? "").replace(/\s+/g, " ").slice(0, 300);
    return `- ${t.id} (done ${t.created_at.slice(0, 10)}): ${gist || "(empty)"}`;
  });
  return `\n\nPRIOR EVIDENCE for this task (already established — do NOT re-derive, extend or correct it):\n${lines.join("\n")}`;
}

/** The OS preamble every dispatch carries. */
function wrapDispatch(prompt: string, evidence: string, investigation: boolean): string {
  const doctrine = [
    "[OS DISPATCH DIRECTIVE]",
    "You are executing real work on this machine. Your deliverable is a CHANGE plus proof:",
    "files edited, a build/test run, an artifact produced — with the raw command output that shows it.",
    "A report describing what you WOULD change is not a deliverable and will be rejected.",
    "Use your local tools: edit, run the build, run the tests, then report exactly what changed.",
    investigation
      ? "This dispatch is the ONE allowed discovery pass for this task: report raw facts, keep it short, and expect the next dispatch to be an action."
      : "Do not stop at analysis. Make the change.",
    "[END DIRECTIVE]",
    "",
  ].join("\n");
  return `${doctrine}${prompt}${evidence}`;
}
