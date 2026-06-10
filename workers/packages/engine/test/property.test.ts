/**
 * Property/fuzz tests (D8, §15.4). The PRNG is a plain 32-bit LCG so the
 * Dart engine can mirror the exact same sequences (same seeds → same cases
 * in both languages — cross-language determinism for free).
 */
import { describe, expect, it } from 'vitest';
import {
  assertConservation,
  computeNetBalances,
  computeShares,
  simplifyDebts,
  type ExpenseRecord,
  type SplitParticipant,
  type UserRecord,
} from '../src/index.js';

/** Deterministic 32-bit LCG (Numerical Recipes constants). Mirrored in Dart. */
class Lcg {
  constructor(private state: number) {}
  /** integer in [0, bound) */
  nextInt(bound: number): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state % bound;
  }
}

const ITERATIONS = 1000;
const SEED = 20260610;

describe('money-math properties', () => {
  it(`splits always sum to total and never go negative (${ITERATIONS} random cases)`, () => {
    const rng = new Lcg(SEED);
    for (let i = 0; i < ITERATIONS; i++) {
      const n = 1 + rng.nextInt(10);
      const total = 1 + rng.nextInt(1_000_000_000);
      const participants: SplitParticipant[] = [];
      const kind = rng.nextInt(3);
      if (kind === 0) {
        for (let j = 0; j < n; j++) participants.push({ userId: `u${String(j).padStart(2, '0')}` });
      } else if (kind === 1) {
        // random basis points summing to exactly 10000
        let remaining = 10_000;
        for (let j = 0; j < n; j++) {
          const bp = j === n - 1 ? remaining : rng.nextInt(remaining + 1);
          remaining -= bp;
          participants.push({ userId: `u${String(j).padStart(2, '0')}`, bp });
        }
      } else {
        for (let j = 0; j < n; j++) {
          participants.push({ userId: `u${String(j).padStart(2, '0')}`, weight: 1 + rng.nextInt(99) });
        }
      }
      const splitType = kind === 0 ? 'equal' : kind === 1 ? 'percent' : 'shares';
      const shares = computeShares({ splitType, amountTotal: total, participants });
      expect(shares.size).toBe(n);
      let sum = 0;
      for (const v of shares.values()) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(v)).toBe(true);
        sum += v;
      }
      expect(sum).toBe(total);
    }
  });
});

describe('ledger properties', () => {
  it(`random ledgers conserve to zero and simplify within n-1 (${ITERATIONS} cases)`, () => {
    const rng = new Lcg(SEED + 1);
    for (let i = 0; i < ITERATIONS; i++) {
      const memberCount = 2 + rng.nextInt(7);
      const memberIds = Array.from({ length: memberCount }, (_, j) => `u${String(j).padStart(2, '0')}`);
      const users = new Map<string, UserRecord>(
        memberIds.map((id) => [id, { id, status: 'active' as const, mergedInto: null }]),
      );

      const expenses: ExpenseRecord[] = [];
      const expenseCount = 1 + rng.nextInt(8);
      for (let e = 0; e < expenseCount; e++) {
        const payer = memberIds[rng.nextInt(memberCount)]!;
        const participantCount = 1 + rng.nextInt(memberCount);
        // deterministic subset: rotate from a random start
        const start = rng.nextInt(memberCount);
        const chosen = Array.from(
          { length: participantCount },
          (_, k) => memberIds[(start + k) % memberCount]!,
        );
        const total = 1 + rng.nextInt(100_000);
        const shares = computeShares({
          splitType: 'equal',
          amountTotal: total,
          participants: chosen.map((userId) => ({ userId })),
        });
        expenses.push({
          id: `e${e}`,
          paidBy: payer,
          amountTotal: total,
          splits: Object.fromEntries(shares),
        });
      }

      const net = computeNetBalances(users, expenses, []);
      assertConservation(net);

      const transfers = simplifyDebts(net);
      const nonZero = [...net.values()].filter((v) => v !== 0).length;
      expect(transfers.length).toBeLessThanOrEqual(Math.max(0, nonZero - 1));

      // transfers settle the nets exactly
      const remaining = new Map(net);
      for (const t of transfers) {
        expect(t.amount).toBeGreaterThan(0);
        remaining.set(t.from, (remaining.get(t.from) ?? 0) + t.amount);
        remaining.set(t.to, (remaining.get(t.to) ?? 0) - t.amount);
      }
      for (const v of remaining.values()) expect(v).toBe(0);

      // determinism: recomputation yields the identical plan
      expect(simplifyDebts(net)).toEqual(transfers);
    }
  });
});
