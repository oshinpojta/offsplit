/**
 * Golden vector runner (X1). The JSON fixtures in offsplit/engine-vectors are
 * the single source of truth for engine behavior; the Dart engine runs the
 * exact same files. Any behavioral change starts in the vectors.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyMergePlan,
  applyReverse,
  applySettlementTransition,
  assertConservation,
  computeNetBalances,
  computePairwiseDebts,
  computeShares,
  EngineError,
  planMerge,
  settlementBalanceApplied,
  simplifyDebts,
  type ExpenseRecord,
  type SettlementRecord,
  type UserRecord,
} from '../src/index.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const VECTORS_DIR = resolve(TEST_DIR, '../../../../engine-vectors');

function expectEngineError(run: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected EngineError ${code}`).toBeInstanceOf(EngineError);
  expect((thrown as EngineError).code).toBe(code);
}

interface VectorFile {
  suite: string;
  description: string;
  cases: VectorCase[];
}

type VectorCase = Record<string, any> & { name: string; kind: string };

function loadVectorFiles(): VectorFile[] {
  const files: VectorFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) {
        files.push(JSON.parse(readFileSync(full, 'utf8')) as VectorFile);
      }
    }
  };
  walk(VECTORS_DIR);
  return files;
}

function buildUsers(defs: Array<{ id: string; ghost?: boolean }>): Map<string, UserRecord> {
  const users = new Map<string, UserRecord>();
  for (const def of defs) {
    users.set(def.id, {
      id: def.id,
      status: 'active',
      mergedInto: null,
      ...(def.ghost ? { isGhost: true } : {}),
    });
  }
  return users;
}

function buildExpense(raw: any): ExpenseRecord {
  return {
    id: raw.id,
    paidBy: raw.paid_by,
    amountTotal: raw.amount_total,
    splits: raw.splits,
    ...(raw.deleted ? { deleted: true } : {}),
  };
}

function netToObject(net: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries([...net.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

function runScenario(testCase: VectorCase): void {
  const users = buildUsers(testCase.users);
  const expenses: ExpenseRecord[] = (testCase.expenses as any[]).map(buildExpense);
  const settlements: SettlementRecord[] = (testCase.settlements as any[]).map((s) => ({
    id: s.id,
    from: s.from,
    to: s.to,
    amount: s.amount,
    status: s.status,
  }));
  const expected = testCase.expect;

  const execute = () => {
    if (expected.netBefore) {
      expect(netToObject(computeNetBalances(users, expenses, settlements))).toEqual(
        expected.netBefore,
      );
    }
    for (const step of testCase.steps ?? []) {
      if (step.op === 'merge') {
        const plan = planMerge(users, step.primary, step.merged);
        if (step.expect_noop) expect(plan.kind).toBe('noop');
        applyMergePlan(users, plan);
      } else if (step.op === 'reverse') {
        applyReverse(users, step.merged);
      } else if (step.op === 'add_expense') {
        expenses.push(buildExpense(step.expense));
      } else {
        throw new Error(`unknown step op: ${step.op}`);
      }
    }
  };

  if (expected.error) {
    expectEngineError(execute, expected.error);
    return;
  }
  execute();

  const net = computeNetBalances(users, expenses, settlements);
  assertConservation(net);
  if (expected.net) expect(netToObject(net)).toEqual(expected.net);
  if (expected.transfers) expect(simplifyDebts(net)).toEqual(expected.transfers);
  if (expected.pairwise) {
    expect(computePairwiseDebts(users, expenses, settlements)).toEqual(expected.pairwise);
  }
  if (expected.users) {
    for (const [id, fields] of Object.entries<any>(expected.users)) {
      const user = users.get(id);
      expect(user, `user ${id}`).toBeDefined();
      if ('status' in fields) expect(user!.status, `user ${id} status`).toBe(fields.status);
      if ('merged_into' in fields) {
        expect(user!.mergedInto, `user ${id} merged_into`).toBe(fields.merged_into);
      }
    }
  }
}

function runSplit(testCase: VectorCase): void {
  const participants = (testCase.participants as any[]).map((p) => ({
    userId: p.user_id,
    ...(p.amount !== undefined ? { amount: p.amount } : {}),
    ...(p.bp !== undefined ? { bp: p.bp } : {}),
    ...(p.weight !== undefined ? { weight: p.weight } : {}),
  }));
  const run = () =>
    computeShares({
      splitType: testCase.split_type,
      amountTotal: testCase.amount_total,
      participants,
    });

  if (testCase.expect.error) {
    expectEngineError(run, testCase.expect.error);
    return;
  }
  const shares = run();
  expect(Object.fromEntries(shares)).toEqual(testCase.expect.shares);
  let sum = 0;
  for (const v of shares.values()) sum += v;
  expect(sum).toBe(testCase.amount_total);
}

function runTransition(testCase: VectorCase): void {
  const run = () => applySettlementTransition(testCase.from, testCase.action);
  if (testCase.expect.error) {
    expectEngineError(run, testCase.expect.error);
    return;
  }
  expect(run()).toBe(testCase.expect.status);
}

const vectorFiles = loadVectorFiles();

it('vector files are present', () => {
  expect(vectorFiles.length).toBeGreaterThanOrEqual(5);
});

for (const file of vectorFiles) {
  describe(file.suite, () => {
    for (const testCase of file.cases) {
      it(testCase.name, () => {
        switch (testCase.kind) {
          case 'split':
            runSplit(testCase);
            break;
          case 'scenario':
            runScenario(testCase);
            break;
          case 'transition':
            runTransition(testCase);
            break;
          case 'balance_effect':
            expect(settlementBalanceApplied(testCase.status)).toBe(testCase.expect.applied);
            break;
          default:
            throw new Error(`unknown case kind: ${testCase.kind}`);
        }
      });
    }
  });
}
