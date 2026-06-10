/**
 * Test harness: a node:sqlite shim implementing the D1Like surface (real D1
 * is structurally identical), plus a self-signed RS256 JWT mint with the JWK
 * set injected through AUTH_JWKS_JSON — the exact verification code path
 * used against Google's keys in production.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

// node:sqlite is a prefix-only builtin that Vite mis-resolves under vitest;
// process.getBuiltinModule (Node 22.3+) loads it without a static import.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
type DatabaseSync = DatabaseSyncType;
import { createApp } from '../src/app.js';
import type { D1Like, D1RunResult, D1StmtLike, Env } from '../src/d1.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ID = 'offsplit-test';

class ShimStmt implements D1StmtLike {
  private params: unknown[] = [];
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...params: unknown[]): D1StmtLike {
    this.params = params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p));
    return this;
  }

  async first<T>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...(this.params as never[]));
    return (row as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...(this.params as never[])) as T[] };
  }

  async run(): Promise<D1RunResult> {
    const info = this.db.prepare(this.sql).run(...(this.params as never[]));
    return { meta: { changes: Number(info.changes) } };
  }
}

export class D1Shim implements D1Like {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): D1StmtLike {
    return new ShimStmt(this.db, sql);
  }

  /** Atomic like real D1 batch. */
  async batch(statements: D1StmtLike[]): Promise<D1RunResult[]> {
    this.db.exec('BEGIN');
    try {
      const results: D1RunResult[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

export interface TestContext {
  env: Env;
  app: ReturnType<typeof createApp>;
  /** Mint a Firebase-shaped ID token for the given Google sub. */
  token: (sub: string, claims?: { email?: string; name?: string }) => Promise<string>;
  /** Mint an ALREADY-EXPIRED token with the real test key. */
  expiredToken: (sub: string) => Promise<string>;
  request: (
    method: string,
    path: string,
    options?: { token?: string; body?: unknown },
  ) => Promise<Response>;
}

export async function createTestContext(): Promise<TestContext> {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(resolve(TEST_DIR, '../migrations/0001_init.sql'), 'utf8'));
  const db = new D1Shim(sqlite);

  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  const env: Env = {
    DB: db,
    FIREBASE_PROJECT_ID: PROJECT_ID,
    AUTH_JWKS_JSON: JSON.stringify({ keys: [jwk] }),
  };
  const app = createApp();

  const token: TestContext['token'] = (sub, claims = {}) =>
    new SignJWT({ email: claims.email ?? `${sub}@example.com`, name: claims.name ?? sub })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setSubject(sub)
      .setIssuer(`https://securetoken.google.com/${PROJECT_ID}`)
      .setAudience(PROJECT_ID)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

  const expiredToken: TestContext['expiredToken'] = (sub) =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setSubject(sub)
      .setIssuer(`https://securetoken.google.com/${PROJECT_ID}`)
      .setAudience(PROJECT_ID)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(privateKey);

  const request: TestContext['request'] = async (method, path, options = {}) =>
    app.request(
      path,
      {
        method,
        headers: {
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      },
      env,
    );

  return { env, app, token, expiredToken, request };
}

/** Sign up a user via the real /auth/session path; returns their token + user id. */
export async function signUp(
  ctx: TestContext,
  sub: string,
  name?: string,
): Promise<{ token: string; userId: string }> {
  const token = await ctx.token(sub, name !== undefined ? { name } : {});
  const response = await ctx.request('POST', '/auth/session', { token });
  if (response.status !== 200) {
    throw new Error(`signUp failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { user: { id: string } };
  return { token, userId: body.user.id };
}
