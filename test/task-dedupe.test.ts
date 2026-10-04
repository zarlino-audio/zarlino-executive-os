/**
 * Task de-duplication — the org must not re-create work it already has.
 *
 * Observed on the live board before this guard: the same ZScorch UI inspection
 * twice, several "reconcile" audits, and a probe re-asked after its report had
 * already landed. Each twin spawned its own agent run.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { createTask } from "../src/core/tasks/model";
import { titleSimilarity, findDuplicateTask, normalizeTitle, isSameWork } from "../src/core/tasks/dedupe";

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

function add(title: string, status = "OPEN"): string {
  const task = createTask({ title, status, source: "test" });
  store.insertTask(task);
  return task.id;
}

describe("titleSimilarity", () => {
  it("matches reworded versions of the same work", () => {
    expect(
      titleSimilarity(
        "ZScorch: advanced-panel-only UI, remove 3 knobs",
        "ZScorch advanced panel only UI remove 3 knobs",
      ),
    ).toBeGreaterThan(0.9);
  });
  it("keeps different work apart", () => {
    expect(titleSimilarity("Build the ZTame installer", "Write the privacy policy page")).toBeLessThan(0.3);
    // One decisive word is enough: a different product is different work.
    expect(isSameWork("Fix the licence gate in ZScorch", "Fix the licence gate in ZTame")).toBe(false);
  });
  it("ignores decoration and case", () => {
    expect(normalizeTitle("TASK: [P1] Fix   the GATE")).toBe("fix the gate");
  });
});

describe("findDuplicateTask", () => {
  it("finds an open twin", () => {
    const id = add("Verify ZTame Pro build passes the release gate");
    const hit = findDuplicateTask(store, "Verify that the ZTame Pro build passes the release gate");
    expect(hit?.id).toBe(id);
    expect(hit?.status).toBe("OPEN");
  });

  it("leaves genuinely different work alone", () => {
    add("Verify ZTame Pro build passes the release gate");
    expect(findDuplicateTask(store, "Publish the songwriting platform to production")).toBeNull();
  });

  it("does not block a task that is DONE and old", () => {
    const task = createTask({ title: "Ship the ZScorch free tier", status: "DONE", source: "test" });
    // Pretend it finished long ago.
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    store.insertTask({ ...task, created_at: old, updated_at: old });
    expect(findDuplicateTask(store, "Ship the ZScorch free tier")).toBeNull();
  });

  it("still recalls a recently completed twin so work is extended, not restarted", () => {
    const task = createTask({ title: "Ship the ZScorch free tier", status: "DONE", source: "test" });
    store.insertTask(task);
    const hit = findDuplicateTask(store, "Ship the ZScorch free tier");
    expect(hit?.id).toBe(task.id);
    expect(hit?.status).toBe("DONE");
  });

  it("reports how close the match was", () => {
    add("ZScorch: advanced-panel-only UI, remove 3 knobs", "IN_PROGRESS");
    const hit = findDuplicateTask(store, "ZScorch advanced panel only UI remove 3 knobs");
    expect(hit).toBeTruthy();
    expect(hit!.similarity).toBeGreaterThan(0.7);
  });

  it("never swallows a different product", () => {
    add("Fix the licence gate in ZScorch");
    expect(findDuplicateTask(store, "Fix the licence gate in ZTame")).toBeNull();
  });
});
