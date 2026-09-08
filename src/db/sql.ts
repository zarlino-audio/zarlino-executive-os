/**
 * Minimal Sql abstraction over the two runtimes the Executive OS targets:
 *   - Cloudflare Durable Object SQLite (production): state.storage.sql
 *   - node:sqlite (tests / local tooling)
 *
 * Kept dependency-free of both runtimes so this file bundles cleanly into the
 * Worker and runs unchanged under node.
 */

export type SqlParam =
  | string
  | number
  | boolean
  | bigint
  | null
  | ArrayBuffer
  | Uint8Array;

export interface Sql {
  /** Execute a statement (may be multi-statement when no params are given). */
  run(sql: string, ...params: SqlParam[]): void;
  /** Run a query and return all rows as objects keyed by column name. */
  all<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    ...params: SqlParam[]
  ): T[];
}

/** Structural shape of node:sqlite's DatabaseSync (no hard import). */
export interface NodeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: SqlParam[]): unknown;
    all(...params: SqlParam[]): unknown[];
  };
}

/** Adapter for node:sqlite (tests / local tooling). */
export function createNodeSql(db: NodeSqliteDatabase): Sql {
  return {
    run(sql, ...params) {
      if (params.length === 0) {
        // exec handles single- AND multi-statement strings.
        db.exec(sql);
        return;
      }
      db.prepare(sql).run(...params);
    },
    all<T extends Record<string, unknown>>(sql: string, ...params: SqlParam[]): T[] {
      return db.prepare(sql).all(...params) as T[];
    },
  };
}

/** Structural shape of the DO's SqlStorage.sql surface we use. */
export interface DoSqlStorage {
  exec(query: string, ...values: unknown[]): {
    toArray(): Record<string, unknown>[];
  };
}

/** Adapter for the Durable Object SQLite storage. */
export function createDoSql(storageSql: DoSqlStorage): Sql {
  return {
    run(sql, ...params) {
      storageSql.exec(sql, ...params);
    },
    all<T extends Record<string, unknown>>(sql: string, ...params: SqlParam[]): T[] {
      return storageSql.exec(sql, ...params).toArray() as T[];
    },
  };
}
