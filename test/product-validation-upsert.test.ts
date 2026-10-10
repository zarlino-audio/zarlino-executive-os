/**
 * Regression: recording validation evidence twice must not explode.
 *
 * Live incident (CEO, ZTame v1.2.0 objective): the CAO tried to record the
 * validation gate for `prod_ztame` a second time and the tool returned
 * "no such column: id" — the generic store updater assumed every table is keyed
 * by `id`, while `product_validations` is keyed by `product_id`. The evidence
 * write silently became impossible, and the CAO had to park the evidence on a
 * task instead. This test pins the fix on the path the tool actually uses.
 *
 * Note: migrations seed product_validations (prod_zscorch / prod_ztame), so
 * every assertion here counts rows for one product, never the whole table.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import type { ProductValidation } from "../src/types";
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

function validation(overrides: Partial<ProductValidation> = {}): ProductValidation {
  const now = nowIso();
  return {
    product_id: "prod_probe",
    stage: "validation",
    engineering: "FAIL",
    measurement: "INCONCLUSIVE",
    perceptual: "INCONCLUSIVE",
    workflow: "INCONCLUSIVE",
    commercial: "INCONCLUSIVE",
    governance: "PASS",
    decision: "NONE",
    iteration: 1,
    notes_json: "[]",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

const rowsFor = (productId: string) => store.listProductValidations().filter((v) => v.product_id === productId);

describe("upsertProductValidation", () => {
  it("inserts on the first write and updates on the second", () => {
    store.upsertProductValidation(validation());
    const first = store.getProductValidation("prod_probe")!;
    expect(first.engineering).toBe("FAIL");

    // Mirrors the tool: the existing created_at is carried forward.
    store.upsertProductValidation(validation({ engineering: "PASS", iteration: 2, created_at: first.created_at }));

    const second = store.getProductValidation("prod_probe")!;
    expect(second.engineering).toBe("PASS");
    expect(second.iteration).toBe(2);
    expect(second.created_at).toBe(first.created_at);
    // One row, not two — the identity is product_id.
    expect(rowsFor("prod_probe")).toHaveLength(1);
  });

  it("keeps the row identity stable across repeated writes", () => {
    store.upsertProductValidation(validation());
    store.upsertProductValidation(validation());
    store.upsertProductValidation(validation({ perceptual: "PASS" }));
    const rows = rowsFor("prod_probe");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.perceptual).toBe("PASS");
  });

  it("does not clobber a recorded founder decision in the seeded row", () => {
    // The partial payload leaves decision fields untouched (spec §24: a recorded
    // founder decision is never overwritten by an evidence write).
    const before = store.getProductValidation("prod_ztame")!;
    store.upsertProductValidation(validation({ product_id: "prod_ztame", engineering: "PASS" }));
    const after = store.getProductValidation("prod_ztame")!;
    expect(after.decision_by).toBe(before.decision_by);
    expect(after.decision_note).toBe(before.decision_note);
    expect(rowsFor("prod_ztame")).toHaveLength(1);
  });
});
