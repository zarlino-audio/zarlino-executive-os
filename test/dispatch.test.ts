/**
 * Dispatch policy tests — the guard against "research instead of work".
 *
 * Live evidence that motivated this (2026-10-04): 30 local dispatches in a
 * week, nearly all read-only probes, several duplicated, one re-asking a task
 * whose report had already been delivered. No file was ever edited.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { isInvestigationPrompt, prepareDispatch, promptKey } from "../src/core/org/dispatch";

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

function queue(prompt: string, taskId?: string, status = "PENDING", result?: string): string {
  const id = `ltk_test_${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  store.createLocalTask({
    id,
    created_at: now,
    updated_at: now,
    source: "executive",
    task_id: taskId,
    prompt,
    status,
    result,
  } as never);
  return id;
}

describe("isInvestigationPrompt", () => {
  it("spots read-only reconnaissance", () => {
    expect(isInvestigationPrompt("READ-ONLY FACT-FIND. Do not modify anything. Report raw evidence.")).toBe(true);
    expect(isInvestigationPrompt("READ-ONLY UI INSPECTION for task tsk_x")).toBe(true);
    expect(isInvestigationPrompt("Produce a complete change-map for the website. Do not apply.")).toBe(true);
  });
  it("treats anything that changes files as work", () => {
    expect(isInvestigationPrompt("READ-ONLY inspection first, then fix the licence gate in the editor")).toBe(false);
    expect(isInvestigationPrompt("Implement the three-knob UI and build the plugin")).toBe(false);
    expect(isInvestigationPrompt("Clone the missing repos and report per-repo status")).toBe(false);
  });
  it("leaves ordinary implementation prompts alone", () => {
    expect(isInvestigationPrompt("Add a wet/dry blend to ZTame Pro and run the tests")).toBe(false);
  });
});

describe("prepareDispatch", () => {
  it("refuses an identical request already queued", () => {
    const first = prepareDispatch(store, { prompt: "Run the ZTame release gate", taskId: "tsk_a" });
    expect(first.ok).toBe(true);
    queue("Run the ZTame release gate", "tsk_a");

    const second = prepareDispatch(store, { prompt: "  run the   ZTame RELEASE gate ", taskId: "tsk_a" });
    expect(second.ok).toBe(false);
    expect(second.code).toBe("DUPLICATE");
    expect(second.existingId).toBeTruthy();
    expect(second.error).toContain("already dispatched");
  });

  it("allows exactly one read-only pass per task, then refuses the next", () => {
    queue("READ-ONLY INSPECTION: report the editor layout", "tsk_ui", "DONE", "PluginEditor.h is 100 lines long...");

    const again = prepareDispatch(store, {
      prompt: "READ-ONLY INSPECTION: report the editor layout again",
      taskId: "tsk_ui",
    });
    expect(again.ok).toBe(false);
    expect(again.code).toBe("INVESTIGATION_LIMIT");
    expect(again.error).toContain("INVESTIGATION_LIMIT");
    expect(again.error).toContain("PluginEditor.h is 100 lines");
  });

  it("refuses a second probe while the first is still queued", () => {
    queue("READ-ONLY PROBE: what tools exist on the box", "tsk_probe", "PENDING");
    const second = prepareDispatch(store, {
      prompt: "READ-ONLY audit of the available tools on this machine",
      taskId: "tsk_probe",
    });
    expect(second.ok).toBe(false);
    expect(second.code).toBe("DUPLICATE");
  });

  it("still allows an ACTION after a discovery pass", () => {
    queue("READ-ONLY INSPECTION: report the editor layout", "tsk_ui2", "DONE", "layout facts");
    const act = prepareDispatch(store, {
      prompt: "Remove three knobs from the advanced panel and build the plugin",
      taskId: "tsk_ui2",
    });
    expect(act.ok).toBe(true);
    expect(act.investigation).toBe(false);
    expect(act.prompt).toContain("[OS DISPATCH DIRECTIVE - Zarlino Constitution, binding]");
    expect(act.prompt).toContain("Your deliverable is a CHANGE plus proof");
  });

  it("carries prior evidence so the machine stops re-deriving facts", () => {
    queue("READ-ONLY INSPECTION: export the plugin editor header", "tsk_ev", "DONE", "PluginEditor.h has 12 knobs and no advanced gate");
    const act = prepareDispatch(store, {
      prompt: "Edit PluginEditor to hide the basic knobs and build",
      taskId: "tsk_ev",
    });
    expect(act.ok).toBe(true);
    expect(act.prompt).toContain("PRIOR EVIDENCE");
    expect(act.prompt).toContain("PluginEditor.h has 12 knobs");
  });

  it("marks the single allowed discovery pass as such", () => {
    const probe = prepareDispatch(store, { prompt: "READ-ONLY FACT-FIND: list the repos on this machine", taskId: "tsk_disc" });
    expect(probe.ok).toBe(true);
    expect(probe.investigation).toBe(true);
    expect(probe.prompt).toContain("ONE allowed discovery pass");
  });

  it("does not confuse prompts that differ materially", () => {
    queue("Build the ZScorch release", "tsk_b");
    const other = prepareDispatch(store, { prompt: "Build the ZTame release", taskId: "tsk_b" });
    expect(other.ok).toBe(true);
  });

  it("normalises formatting when comparing", () => {
    expect(promptKey("Run   the TESTS!")).toBe(promptKey("run the tests"));
  });

  it("survives a BOM or control bytes instead of crashing the route", () => {
    // Live failure 2026-10-04: a prompt whose first character was a UTF-8 BOM
    // returned a bare HTTP 500 from the dispatch route.
    const bom = "\uFEFF";
    const nasty = `${bom}Clone the missing repos and report per-repo status\u0007\u0000`;
    const decision = prepareDispatch(store, { prompt: nasty, taskId: "tsk_bom" });
    expect(decision.ok).toBe(true);
    expect(decision.prompt).not.toContain(bom);
    expect(decision.prompt).not.toContain("\u0007");
    expect(decision.prompt).toContain("Clone the missing repos");
  });
});
