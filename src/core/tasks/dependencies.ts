/**
 * Task dependency contract — the scheduler half of objective linkage.
 *
 * A task may name the task it depends on (`dependency_task_id`). Code review on
 * the live board made the gap obvious: the field was stored and shown, but the
 * auto-run sweep ignored it, so a verification task started in parallel with the
 * engineering run it was supposed to verify. That is not coordination — it is
 * parallel guesswork on an input that has not arrived yet.
 *
 * Two rules make the field real:
 *   1. GATE — a dependent task does not start while its predecessor is not DONE.
 *   2. RELEASE — a task that was BLOCKED while waiting on its predecessor
 *      becomes runnable again the moment the predecessor completes, so an
 *      objective cannot stall on work that has since been finished.
 *
 * Terminal-but-not-DONE predecessors (CANCELLED) keep dependents waiting: the
 * plan itself needs a human/CEO decision, and silently running "the next step"
 * of a cancelled step would be worse than standing still.
 */

/** Minimal store surface this contract needs — keeps it unit-testable. */
export interface DependencyStore {
  getTask(id: string): { id: string; status: string; dependency_task_id?: string | null } | null;
  listBlockedDependents(): Array<{ id: string; dependency_task_id?: string | null }>;
  updateTask(id: string, patch: { status: string }): void;
}

export type DependencyState = "NONE" | "WAITING" | "READY";

/** Whether a task with a declared dependency may execute right now. */
export function dependencyState(
  store: Pick<DependencyStore, "getTask">,
  task: { dependency_task_id?: string | null },
): DependencyState {
  if (!task.dependency_task_id) return "NONE";
  const predecessor = store.getTask(task.dependency_task_id);
  return predecessor?.status === "DONE" ? "READY" : "WAITING";
}

/**
 * Re-open blocked dependents whose predecessor has completed. Returns the ids
 * released, so the caller can note them (empty array = nothing to do).
 */
export function releaseCompletedDependencies(store: DependencyStore): string[] {
  const released: string[] = [];
  for (const task of store.listBlockedDependents()) {
    if (dependencyState(store, task) !== "READY") continue;
    store.updateTask(task.id, { status: "OPEN" });
    released.push(task.id);
  }
  return released;
}
