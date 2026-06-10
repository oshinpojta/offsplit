import { EngineError } from './errors.js';
import { effectiveUserId } from './identity.js';
import type { UserRecord } from './types.js';

/**
 * Merge planning (§6, M1–M3). Pure: returns what should change; the caller
 * (Workers, inside a D1 transaction with CAS — D1 in the design doc) applies
 * it. A merge mutates ONLY the merged user's row (A0/M2).
 */
export type MergePlan =
  | { kind: 'noop'; survivorId: string }
  | { kind: 'merge'; survivorId: string; mergedId: string };

/** Resolution-first (M3): resolve both ids to live survivors, then decide. */
export function planMerge(
  users: ReadonlyMap<string, UserRecord>,
  primaryId: string,
  mergedId: string,
): MergePlan {
  const survivorId = effectiveUserId(users, primaryId);
  const target = effectiveUserId(users, mergedId);
  if (survivorId === target) return { kind: 'noop', survivorId };
  return { kind: 'merge', survivorId, mergedId: target };
}

/** Apply a merge plan to an in-memory user map (the engine-side mirror of the D1 CAS write). */
export function applyMergePlan(users: Map<string, UserRecord>, plan: MergePlan): void {
  if (plan.kind === 'noop') return;
  const merged = users.get(plan.mergedId);
  if (!merged) throw new EngineError('unknown_user', plan.mergedId);
  users.set(plan.mergedId, { ...merged, status: 'merged', mergedInto: plan.survivorId });
  // D1 tripwire: resolving the merged user must terminate at the survivor.
  const resolved = effectiveUserId(users, plan.mergedId);
  if (resolved !== plan.survivorId) {
    throw new EngineError('merge_cycle', `post-merge resolution mismatch: ${resolved}`);
  }
}

/**
 * Reversal (R5/T3): restore the merged user. Trivially exact because the
 * merge wrote exactly one row (A0) — flipping it back restores all balances
 * by construction.
 */
export function planReverse(users: ReadonlyMap<string, UserRecord>, mergedId: string): void {
  const user = users.get(mergedId);
  if (!user) throw new EngineError('unknown_user', mergedId);
  if (user.status !== 'merged') throw new EngineError('not_merged', mergedId);
}

export function applyReverse(users: Map<string, UserRecord>, mergedId: string): void {
  planReverse(users, mergedId);
  const user = users.get(mergedId)!;
  users.set(mergedId, { ...user, status: 'active', mergedInto: null });
}
