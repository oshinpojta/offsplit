/**
 * Structural subset of Cloudflare's D1 API that the store uses. The real
 * `D1Database` binding satisfies this; tests satisfy it with a node:sqlite
 * shim. Keeping the surface minimal is what makes the store portable and
 * the group-resolver seam (§10.3) honest.
 */
export interface D1Like {
  prepare(sql: string): D1StmtLike;
  batch(statements: D1StmtLike[]): Promise<D1RunResult[]>;
}

export interface D1StmtLike {
  bind(...params: unknown[]): D1StmtLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<D1RunResult>;
}

export interface D1RunResult {
  meta: { changes: number };
}

export interface Env {
  DB: D1Like;
  FIREBASE_PROJECT_ID: string;
  /** Test/pinning escape hatch: JSON JWK set used instead of Google's remote set. */
  AUTH_JWKS_JSON?: string;
}

/**
 * Group-resolver seam (§10.3 / BUILD_SPEC "decide the sharding seam now"):
 * every query asks this for its database. Today: one D1. Later: hash-shard
 * by group_id or Durable-Object-per-group — swapped here, nowhere else.
 */
export function dbForGroup(env: Env, _groupId: string): D1Like {
  return env.DB;
}

export function rootDb(env: Env): D1Like {
  return env.DB;
}
