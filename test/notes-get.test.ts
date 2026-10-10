/**
 * Regression: task evidence whose locator is `note <id>` must be readable.
 *
 * Live incident (CEO seat, ZTame v1.2.0 objective verification): the marketing
 * task's evidence pointed at note `nt_mv38e2pd_0pbl0iyx7qcr`, which exists.
 * The CEO tried `executive.get_file` with that id, got {"status":"NOT_FOUND"},
 * and — correctly, given what it could see — refused to accept the criterion
 * and filed the gap as a blocker. The note had no read path by id: only
 * `notes.list_notes` (previews) and `executive.get_file` (Founder uploads).
 * That is how real evidence gets rejected as if it were empty.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { buildToolRegistry } from "../src/agent/tools";
import { nowIso } from "../src/ids";

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

const registry = () => buildToolRegistry({ env: {}, sink: { recordExecution: () => {} } });
const ctx = () => ({ env: {} as Record<string, string | undefined>, store, audit: () => {} });

function seedNote(id: string, title: string, body: string): void {
  const now = nowIso();
  store.createNote({
    id,
    title,
    body,
    tags_json: "[]",
    pinned: 0,
    source: "executive",
    created_at: now,
    updated_at: now,
  } as never);
}

describe("notes.get_note", () => {
  it("returns the full body for a bare note id", async () => {
    seedNote("nt_test_1", "Drafts", "DRAFT 1: store blurb\nDRAFT 2: announcement email");
    const r = await registry().run("notes.get_note", { noteId: "nt_test_1" }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = r.output as { title: string; body: string; status?: string };
      expect(out.status).toBeUndefined();
      expect(out.title).toBe("Drafts");
      expect(out.body).toContain("DRAFT 2: announcement email");
    }
  });

  it("accepts the `note <id>` locator form used in task evidence", async () => {
    seedNote("nt_test_2", "Evidence target", "the actual content");
    const r = await registry().run("notes.get_note", { noteId: "note nt_test_2 — \"some title\"" }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = r.output as { noteId: string; body: string };
      expect(out.noteId).toBe("nt_test_2");
      expect(out.body).toBe("the actual content");
    }
  });

  it("reports NOT_FOUND for an unknown id instead of pretending success", async () => {
    const r = await registry().run("notes.get_note", { noteId: "nt_nope" }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.output as { status?: string }).status).toBe("NOT_FOUND");
  });

  it("does not read notes through executive.get_file — the tool that produced the false NOT_FOUND", async () => {
    seedNote("nt_test_3", "Not an upload", "body");
    const r = await registry().run("executive.get_file", { fileId: "nt_test_3" }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.output as { status?: string }).status).toBe("NOT_FOUND");
  });
});
