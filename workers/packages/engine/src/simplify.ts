import type { Transfer } from './types.js';

/**
 * Greedy min-cash-flow debt simplification (§7.3, M11). Deterministic:
 * largest creditor matched with largest debtor, ties broken by user_id
 * ascending, so suggested transfers never flicker between recomputes.
 * Produces <= n-1 transfers that settle the nets exactly.
 */
export function simplifyDebts(net: ReadonlyMap<string, number>): Transfer[] {
  const creditors: Array<{ id: string; amount: number }> = [];
  const debtors: Array<{ id: string; amount: number }> = [];
  for (const [id, value] of net) {
    if (value > 0) creditors.push({ id, amount: value });
    else if (value < 0) debtors.push({ id, amount: -value });
  }

  const pickMax = (list: Array<{ id: string; amount: number }>) => {
    let best = 0;
    for (let i = 1; i < list.length; i++) {
      const candidate = list[i]!;
      const current = list[best]!;
      if (
        candidate.amount > current.amount ||
        (candidate.amount === current.amount && candidate.id < current.id)
      ) {
        best = i;
      }
    }
    return best;
  };

  const transfers: Transfer[] = [];
  while (creditors.length > 0 && debtors.length > 0) {
    const creditorIndex = pickMax(creditors);
    const debtorIndex = pickMax(debtors);
    const creditor = creditors[creditorIndex]!;
    const debtor = debtors[debtorIndex]!;
    const amount = Math.min(creditor.amount, debtor.amount);
    transfers.push({ from: debtor.id, to: creditor.id, amount });
    creditor.amount -= amount;
    debtor.amount -= amount;
    if (creditor.amount === 0) creditors.splice(creditorIndex, 1);
    if (debtor.amount === 0) debtors.splice(debtors.indexOf(debtor), 1);
  }

  return transfers;
}
