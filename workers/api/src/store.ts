/**
 * Data access over D1 (§5.1). Identity rules: merges write exactly ONE user
 * row via single-statement CAS (A0/M2/D1 — SQLite serializes writers, the
 * subquery guards both preconditions atomically); everything resolves at
 * read time. The `aliases` recursive CTE is the reverse closure of
 * `effectiveUserId`: every id that resolves to the caller.
 */
import { EngineError, type UserRecord } from '@offsplit/engine';
import type { D1Like } from './d1.js';
import { ApiError, conflict, notFound } from './errors.js';

export interface UserRow {
  id: string;
  google_sub: string | null;
  email: string | null;
  display_name: string;
  default_upi_id: string | null;
  is_ghost: number;
  status: string;
  merged_into: string | null;
  created_at: number;
  updated_at: number;
}

export interface GroupRow {
  id: string;
  name: string;
  type: string;
  default_currency: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface ExpenseRow {
  id: string;
  group_id: string;
  description: string;
  amount_total: number;
  currency: string;
  paid_by: string;
  split_type: string;
  txn_date: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface SettlementRow {
  id: string;
  group_id: string;
  from_user: string;
  to_user: string;
  amount: number;
  currency: string;
  method: string;
  status: string;
  upi_link: string | null;
  created_at: number;
  updated_at: number;
}

const ALIASES_CTE = `WITH RECURSIVE aliases(id) AS (
  SELECT ?
  UNION
  SELECT u.id FROM users u JOIN aliases a ON u.merged_into = a.id WHERE u.status = 'merged'
)`;

// ── Users ────────────────────────────────────────────────────────────────

export async function getUser(db: D1Like, id: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}

export async function mustGetUser(db: D1Like, id: string): Promise<UserRow> {
  const user = await getUser(db, id);
  if (!user) throw notFound('user_not_found');
  return user;
}

/** Follow merged_into to the live survivor (§5.2, M4/M6). */
export async function effectiveUserId(db: D1Like, id: string): Promise<string> {
  let current = id;
  for (let hops = 0; hops < 32; hops++) {
    const row = await db
      .prepare('SELECT status, merged_into FROM users WHERE id = ?')
      .bind(current)
      .first<{ status: string; merged_into: string | null }>();
    if (!row) throw notFound('user_not_found');
    if (row.status !== 'merged') return current;
    if (!row.merged_into) throw new EngineError('merge_cycle', current);
    current = row.merged_into;
  }
  throw new EngineError('merge_cycle', id);
}

export async function upsertUserBySub(
  db: D1Like,
  identity: { sub: string; email: string | null; name: string | null },
  now: number,
): Promise<UserRow> {
  const existing = await db
    .prepare('SELECT * FROM users WHERE google_sub = ?')
    .bind(identity.sub)
    .first<UserRow>();
  if (existing) {
    await db
      .prepare('UPDATE users SET email = ?, updated_at = ? WHERE id = ?')
      .bind(identity.email, now, existing.id)
      .run();
    // M6: a tombstoned account's sign-in acts as its survivor.
    const survivor = await effectiveUserId(db, existing.id);
    return mustGetUser(db, survivor);
  }
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO users (id, google_sub, email, display_name, is_ghost, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 'active', ?, ?)`,
    )
    .bind(id, identity.sub, identity.email, identity.name ?? 'User', now, now)
    .run();
  return mustGetUser(db, id);
}

/** Engine users map: the given ids plus the closure of their merge chains. */
export async function engineUsers(
  db: D1Like,
  ids: Iterable<string>,
): Promise<Map<string, UserRecord>> {
  const users = new Map<string, UserRecord>();
  let frontier = [...new Set(ids)];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      if (users.has(id)) continue;
      const row = await getUser(db, id);
      if (!row) throw notFound('user_not_found');
      users.set(id, {
        id: row.id,
        status: row.status === 'merged' ? 'merged' : 'active',
        mergedInto: row.merged_into,
        isGhost: row.is_ghost === 1,
      });
      if (row.status === 'merged' && row.merged_into && !users.has(row.merged_into)) {
        next.push(row.merged_into);
      }
    }
    frontier = next;
  }
  return users;
}

// ── Groups & membership ──────────────────────────────────────────────────

export async function getGroup(db: D1Like, id: string): Promise<GroupRow | null> {
  const group = await db
    .prepare('SELECT * FROM groups WHERE id = ? AND deleted_at IS NULL')
    .bind(id)
    .first<GroupRow>();
  return group;
}

export async function mustGetGroup(db: D1Like, id: string): Promise<GroupRow> {
  const group = await getGroup(db, id);
  if (!group) throw notFound('group_not_found');
  return group;
}

/** Is callerId (or anyone who resolves to them) a member? (M4 at the authz layer.) */
export async function isEffectiveMember(
  db: D1Like,
  groupId: string,
  callerId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `${ALIASES_CTE}
       SELECT 1 AS yes FROM group_members m JOIN aliases a ON m.user_id = a.id
       WHERE m.group_id = ? LIMIT 1`,
    )
    .bind(callerId, groupId)
    .first<{ yes: number }>();
  return row !== null;
}

export async function listGroupsFor(db: D1Like, callerId: string): Promise<GroupRow[]> {
  const { results } = await db
    .prepare(
      `${ALIASES_CTE}
       SELECT DISTINCT g.* FROM groups g
       JOIN group_members m ON m.group_id = g.id
       JOIN aliases a ON m.user_id = a.id
       WHERE g.deleted_at IS NULL
       ORDER BY g.updated_at DESC`,
    )
    .bind(callerId)
    .all<GroupRow>();
  return results;
}

export async function listMemberUserIds(db: D1Like, groupId: string): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT user_id FROM group_members WHERE group_id = ?')
    .bind(groupId)
    .all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}

// ── Claim tokens (D3 hardening) ──────────────────────────────────────────

export function mintTokenString(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Single-statement CAS: exactly one claimant can ever win (D1/D3). */
export async function claimTokenCas(
  db: D1Like,
  token: string,
  claimedBy: string,
  now: number,
): Promise<{ ghost_user_id: string } | null> {
  const result = await db
    .prepare(
      `UPDATE claim_tokens SET claimed_by = ?, claimed_at = ?
       WHERE token = ? AND claimed_by IS NULL AND expires_at > ?`,
    )
    .bind(claimedBy, now, token, now)
    .run();
  if (result.meta.changes !== 1) return null;
  return db
    .prepare('SELECT ghost_user_id FROM claim_tokens WHERE token = ?')
    .bind(token)
    .first<{ ghost_user_id: string }>();
}

// ── Merge (A0: writes exactly one user row) ──────────────────────────────

export const MERGE_GRACE_MS = 72 * 60 * 60 * 1000; // 72h (R5)

export interface MergeOutcome {
  kind: 'noop' | 'merged';
  survivorId: string;
  mergeRecordId?: string;
  reversibleUntil?: number;
}

export async function mergeUsers(
  db: D1Like,
  primaryId: string,
  mergedId: string,
  performedBy: string,
  now: number,
): Promise<MergeOutcome> {
  // Resolution-first (M3).
  const survivorId = await effectiveUserId(db, primaryId);
  const targetId = await effectiveUserId(db, mergedId);
  if (survivorId === targetId) return { kind: 'noop', survivorId };

  const targetRow = await mustGetUser(db, targetId);
  const recordId = crypto.randomUUID();
  const reversibleUntil = now + MERGE_GRACE_MS;

  // One atomic batch. The user CAS guards BOTH preconditions in a single
  // statement (B active + A active); the audit INSERT is guarded on the CAS
  // having applied, so the pair commits all-or-nothing.
  const results = await db.batch([
    db
      .prepare(
        `UPDATE users SET status = 'merged', merged_into = ?, updated_at = ?
         WHERE id = ? AND status = 'active'
           AND (SELECT status FROM users WHERE id = ?) = 'active'`,
      )
      .bind(survivorId, now, targetId, survivorId),
    db
      .prepare(
        `INSERT INTO merge_records (id, primary_user_id, merged_user_id, performed_by, performed_at, reversible_until, snapshot)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'merged' AND merged_into = ? AND updated_at = ?)`,
      )
      .bind(
        recordId,
        survivorId,
        targetId,
        performedBy,
        now,
        reversibleUntil,
        JSON.stringify(targetRow),
        targetId,
        survivorId,
        now,
      ),
  ]);

  if (results[0]!.meta.changes !== 1) {
    // Lost a race — re-resolve; idempotent no-op if we now agree (R6/T4).
    const after = await effectiveUserId(db, mergedId);
    if (after === (await effectiveUserId(db, primaryId))) {
      return { kind: 'noop', survivorId: after };
    }
    throw conflict('merge_conflict');
  }

  // D1 tripwire: target must now resolve to the survivor.
  const resolved = await effectiveUserId(db, targetId);
  if (resolved !== survivorId) throw new EngineError('merge_cycle', targetId);

  return { kind: 'merged', survivorId, mergeRecordId: recordId, reversibleUntil };
}

export async function reverseMerge(
  db: D1Like,
  mergeRecordId: string,
  callerId: string,
  now: number,
): Promise<void> {
  const record = await db
    .prepare('SELECT * FROM merge_records WHERE id = ?')
    .bind(mergeRecordId)
    .first<{
      id: string;
      primary_user_id: string;
      merged_user_id: string;
      performed_by: string;
      reversible_until: number;
      reversed_at: number | null;
    }>();
  if (!record) throw notFound('merge_not_found');
  if (record.performed_by !== callerId && record.primary_user_id !== callerId) {
    throw conflict('merge_reverse_forbidden');
  }

  const results = await db.batch([
    db
      .prepare(
        `UPDATE merge_records SET reversed_at = ?
         WHERE id = ? AND reversed_at IS NULL AND reversible_until > ?`,
      )
      .bind(now, mergeRecordId, now),
    db
      .prepare(
        `UPDATE users SET status = 'active', merged_into = NULL, updated_at = ?
         WHERE id = ? AND status = 'merged' AND merged_into = ?
           AND EXISTS (SELECT 1 FROM merge_records WHERE id = ? AND reversed_at = ?)`,
      )
      .bind(now, record.merged_user_id, record.primary_user_id, mergeRecordId, now),
  ]);

  if (results[0]!.meta.changes !== 1) throw conflict('merge_reverse_window_expired');
  if (results[1]!.meta.changes !== 1) throw conflict('merge_reverse_inconsistent');
}

// ── Rate limiting (D3) ───────────────────────────────────────────────────

export async function bumpRateLimit(
  db: D1Like,
  key: string,
  windowMs: number,
  max: number,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO rate_limits (rl_key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(rl_key) DO UPDATE SET
         count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END`,
    )
    .bind(key, now, now - windowMs, now - windowMs, now)
    .run();
  const row = await db
    .prepare('SELECT count FROM rate_limits WHERE rl_key = ?')
    .bind(key)
    .first<{ count: number }>();
  if ((row?.count ?? 0) > max) throw new ApiError(429, 'rate_limited');
}
