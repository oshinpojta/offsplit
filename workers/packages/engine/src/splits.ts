import { EngineError } from './errors.js';
import {
  BP_TOTAL,
  MAX_AMOUNT_PAISE,
  MAX_PARTICIPANTS,
  type SplitInput,
  type SplitParticipant,
} from './types.js';

/**
 * Compute per-participant shares for an expense (M8).
 *
 * One deterministic rounding rule for equal/percent/shares:
 * largest-remainder, ties broken by user_id ascending. Exact splits must
 * sum precisely or are rejected — never auto-fixed.
 *
 * Postcondition (M7): Σ(shares) == amountTotal, every share >= 0.
 */
export function computeShares(input: SplitInput): Map<string, number> {
  const { splitType, amountTotal, participants } = input;

  if (!Number.isInteger(amountTotal) || amountTotal <= 0) {
    throw new EngineError('invalid_amount');
  }
  if (amountTotal > MAX_AMOUNT_PAISE) {
    throw new EngineError('amount_out_of_bounds');
  }
  if (participants.length === 0) {
    throw new EngineError('no_participants');
  }
  if (participants.length > MAX_PARTICIPANTS) {
    throw new EngineError('too_many_participants');
  }
  const ids = new Set<string>();
  for (const p of participants) {
    if (ids.has(p.userId)) throw new EngineError('duplicate_participant', p.userId);
    ids.add(p.userId);
  }

  switch (splitType) {
    case 'exact':
      return exactShares(amountTotal, participants);
    case 'equal':
      return largestRemainder(
        amountTotal,
        participants.map((p) => ({ userId: p.userId, numerator: 1n })),
        BigInt(participants.length),
      );
    case 'percent': {
      let sum = 0;
      for (const p of participants) {
        if (p.bp === undefined || !Number.isInteger(p.bp) || p.bp < 0 || p.bp > BP_TOTAL) {
          throw new EngineError('invalid_percent', p.userId);
        }
        sum += p.bp;
      }
      if (sum !== BP_TOTAL) throw new EngineError('percent_sum_mismatch');
      return largestRemainder(
        amountTotal,
        participants.map((p) => ({ userId: p.userId, numerator: BigInt(p.bp!) })),
        BigInt(BP_TOTAL),
      );
    }
    case 'shares': {
      let totalWeight = 0n;
      for (const p of participants) {
        if (p.weight === undefined || !Number.isInteger(p.weight) || p.weight < 1) {
          throw new EngineError('invalid_weight', p.userId);
        }
        totalWeight += BigInt(p.weight);
      }
      return largestRemainder(
        amountTotal,
        participants.map((p) => ({ userId: p.userId, numerator: BigInt(p.weight!) })),
        totalWeight,
      );
    }
  }
}

function exactShares(amountTotal: number, participants: SplitParticipant[]): Map<string, number> {
  let sum = 0;
  for (const p of participants) {
    if (p.amount === undefined || !Number.isInteger(p.amount)) {
      throw new EngineError('negative_share', p.userId);
    }
    if (p.amount < 0) throw new EngineError('negative_share', p.userId);
    sum += p.amount;
  }
  if (sum !== amountTotal) throw new EngineError('split_sum_mismatch');
  return new Map(participants.map((p) => [p.userId, p.amount!]));
}

/**
 * Largest-remainder apportionment over ideal shares total*numerator/denominator.
 * BigInt throughout — total*numerator can exceed 2^53 (D2 bounds make the
 * inputs legal up to 10^12 * 10^4 = 10^16).
 */
function largestRemainder(
  total: number,
  entries: Array<{ userId: string; numerator: bigint }>,
  denominator: bigint,
): Map<string, number> {
  const totalBig = BigInt(total);
  const computed = entries.map((e) => {
    const product = totalBig * e.numerator;
    return {
      userId: e.userId,
      floor: Number(product / denominator),
      remainder: product % denominator,
    };
  });

  let leftover = total - computed.reduce((acc, c) => acc + c.floor, 0);

  const order = [...computed].sort((x, y) => {
    if (x.remainder !== y.remainder) return x.remainder > y.remainder ? -1 : 1;
    return x.userId < y.userId ? -1 : x.userId > y.userId ? 1 : 0;
  });

  const bonus = new Map<string, number>();
  for (const entry of order) {
    if (leftover === 0) break;
    bonus.set(entry.userId, 1);
    leftover -= 1;
  }

  const shares = new Map<string, number>();
  for (const c of computed) {
    shares.set(c.userId, c.floor + (bonus.get(c.userId) ?? 0));
  }

  // M7 postcondition — belt and braces.
  let sum = 0;
  for (const v of shares.values()) sum += v;
  if (sum !== total) throw new EngineError('split_sum_mismatch', 'internal rounding error');
  return shares;
}
