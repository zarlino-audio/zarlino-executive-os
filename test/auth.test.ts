import { beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { hashPassword, verifyPassword, timingSafeEqual } from "../src/core/auth/passwords";

describe("Founder username/password auth", () => {
  let db: DatabaseSync;
  let store: ExecutiveStore;

  beforeAll(() => {
    db = new DatabaseSync(":memory:");
    store = new ExecutiveStore(createNodeSql(db as never));
    store.migrate();
  });

  it("migration v19 seeds the founder account (Khritical)", () => {
    const creds = store.getFounderCredentials();
    expect(creds).not.toBeNull();
    expect(creds!.username).toBe("Khritical");
    expect(creds!.failed_attempts).toBe(0);
  });

  it("the seeded temporary password verifies; wrong passwords do not", async () => {
    const creds = store.getFounderCredentials()!;
    expect(await verifyPassword("0000", creds.password_hash)).toBe(true);
    expect(await verifyPassword("wrong-password", creds.password_hash)).toBe(false);
    expect(await verifyPassword("0001", creds.password_hash)).toBe(false);
  });

  it("hashPassword round-trips (salt:hex format)", async () => {
    const hash = await hashPassword("s3cret!");
    expect(hash).toContain(":");
    expect(await verifyPassword("s3cret!", hash)).toBe(true);
    expect(await verifyPassword("s3cret?", hash)).toBe(false);
  });

  it("timingSafeEqual is constant-time and correct", () => {
    expect(timingSafeEqual("abc123", "abc123")).toBe(true);
    expect(timingSafeEqual("abc123", "abc124")).toBe(false);
    expect(timingSafeEqual("a", "bb")).toBe(false); // length mismatch
  });

  it("sessions round-trip and deleteSessionsExcept keeps only the caller", () => {
    const now = new Date().toISOString();
    store.createSession({ token: "sess_keep", username: "Khritical", expires_at: new Date(Date.now() + 100000).toISOString() });
    store.createSession({ token: "sess_old", username: "Khritical", expires_at: new Date(Date.now() + 100000).toISOString() });
    expect(store.getSession("sess_keep")?.username).toBe("Khritical");
    expect(store.getSession("sess_old")).not.toBeNull();

    // After a password change, drop all sessions except the caller's.
    store.deleteSessionsExcept("sess_keep");
    expect(store.getSession("sess_keep")).not.toBeNull();
    expect(store.getSession("sess_old")).toBeNull();

    // deleteSessionsExcept(null) clears everything.
    store.deleteSessionsExcept(null);
    expect(store.getSession("sess_keep")).toBeNull();
  });

  it("credential update persists (founder can rotate later)", async () => {
    const hash = await hashPassword("newpass123");
    store.setFounderCredentials({ username: "Khritical", password_hash: hash });
    const creds = store.getFounderCredentials()!;
    expect(await verifyPassword("newpass123", creds.password_hash)).toBe(true);
    expect(await verifyPassword("0000", creds.password_hash)).toBe(false);
    // Restore the seeded credential for idempotency in other tests.
    store.setFounderCredentials({ username: "Khritical", password_hash: creds.password_hash });
  });
});
