/**
 * Task dependencies must gate execution, not merely be displayed.
 *
 * Live evidence: the CEO's cross-department objective put "QA verifies the
 * release-gate evidence" behind "Engineering runs the release gate" — and both
 * agent runs started within the same sweep, because the auto-run scheduler never
 * looked at `dependency_task_id`. QA was about to "verify" a run that did not
 * exist yet.
 *
 * Contract under test:
 *   - dependencyState: NONE without a dependency, WAITING while the predecessor
 *     is unfinished, READY once it is DONE;
 *   - releaseCompletedDependencies: blocked dependents are re-opened only when
 *     their predecessor actually completed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { createTask } from "../src/core/tasks/model";
import { dependencyState, releaseCompletedDependencies } from "../src/core/tasks/dependencies";

let db: DatabaseSync;
let store: ExecutiveStore;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  store = new ExecutiveStore(createNodeSql(db as never));
  store.migrate();
});
afterEach(() => {
  db.close();
});

function add(title: string, patch: { status?: string; dependency?: string } = {}): string {
  const task = createTask({ title, source: "test" });
  store.insertTask(task);
  const update: Record<string, string> = {};
  if (patch.status) update.status = patch.status;
  if (patch.dependency) update.dependency_task_id = patch.dependency;
  if (Object.keys(update).length) store.updateTask(task.id, update as never);
  return task.id;
}

describe("dependencyState", () => {
  it("is NONE for a task without a dependency", () => {
    const task = store.getTask(add("standalone"))!;
    expect(dependencyState(store, task)).toBe("NONE");
  });

  it("is WAITING while the predecessor is OPEN or IN_PROGRESS", () => {
    const predecessor = add("run the release gate");
    const dependent = add("verify the release-gate evidence", { dependency: predecessor });
    expect(dependencyState(store, store.getTask(dependent)!)).toBe("WAITING");
    store.updateTask(predecessor, { status: "IN_PROGRESS" } as never);
    expect(dependencyState(store, store.getTask(dependent)!)).toBe("WAITING");
  });

  it("is READY once the predecessor is DONE", () => {
    const predecessor = add("run the release gate");
    const dependent = add("verify the release-gate evidence", { dependency: predecessor });
    store.updateTask(predecessor, { status: "DONE" } as never);
    expect(dependencyState(store, store.getTask(dependent)!)).toBe("READY");
  });

  it("keeps dependents waiting when the predecessor was CANCELLED", () => {
    // The plan itself no longer holds — silently running "the next step" of a
    // cancelled step is worse than standing still.
    const predecessor = add("run the release gate", { status: "CANCELLED" });
    const dependent = add("verify the release-gate evidence", { dependency: predecessor });
    expect(dependencyState(store, store.getTask(dependent)!)).toBe("WAITING");
  });
});

describe("releaseCompletedDependencies", () => {
  it("re-opens the blocked dependent once its predecessor completes", () => {
    const predecessor = add("run the release gate");
    const dependent = add("verify the release-gate evidence", { status: "BLOCKED", dependency: predecessor });
    expect(releaseCompletedDependencies(store)).toEqual([]);
    expect(store.getTask(dependent)!.status).toBe("BLOCKED");
    store.updateTask(predecessor, { status: "DONE" } as never);
    expect(releaseCompletedDependencies(store)).toEqual([dependent]);
    expect(store.getTask(dependent)!.status).toBe("OPEN");
  });

  it("leaves blocked tasks without a dependency alone", () => {
    const blocked = add("blocked on a founder decision", { status: "BLOCKED" });
    expect(releaseCompletedDependencies(store)).toEqual([]);
    expect(store.getTask(blocked)!.status).toBe("BLOCKED");
  });

  it("does not touch dependents whose predecessor is still unfinished", () => {
    const predecessor = add("run the release gate", { status: "IN_PROGRESS" });
    const dependent = add("verify the release-gate evidence", { status: "BLOCKED", dependency: predecessor });
    expect(releaseCompletedDependencies(store)).toEqual([]);
    expect(store.getTask(dependent)!.status).toBe("BLOCKED");
  });
});
