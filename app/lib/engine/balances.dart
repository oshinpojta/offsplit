import 'errors.dart';
import 'identity.dart';
import 'settlement.dart';
import 'types.dart';

/// Net balance per effective user (§7.2): Σ(paid) − Σ(owed shares) over
/// non-deleted expenses, then applied settlements (M10). Positive = owed to
/// them. Every id passes through effectiveUserId (M4); tombstoned ids never
/// appear as keys. Entries are kept even when they net to zero.
Map<String, int> computeNetBalances(
  Map<String, UserRecord> users,
  List<ExpenseRecord> expenses,
  List<SettlementRecord> settlements,
) {
  final net = <String, int>{};
  void add(String id, int delta) => net[id] = (net[id] ?? 0) + delta;

  for (final expense in expenses) {
    if (expense.deleted) continue;
    _assertSplitsSum(expense);
    add(effectiveUserId(users, expense.paidBy), expense.amountTotal);
    for (final entry in expense.splits.entries) {
      add(effectiveUserId(users, entry.key), -entry.value);
    }
  }

  for (final settlement in settlements) {
    if (!settlementBalanceApplied(settlement.status)) continue;
    add(effectiveUserId(users, settlement.from), settlement.amount);
    add(effectiveUserId(users, settlement.to), -settlement.amount);
  }

  return net;
}

/// Raw pairwise debts — the "who you actually spent with" view (§7.3).
/// Netted per pair; self-pairs filtered (R7). Sorted by (from, to).
List<Transfer> computePairwiseDebts(
  Map<String, UserRecord> users,
  List<ExpenseRecord> expenses,
  List<SettlementRecord> settlements,
) {
  final directed = <String, int>{};
  void add(String from, String to, int delta) {
    final key = '$from $to';
    directed[key] = (directed[key] ?? 0) + delta;
  }

  for (final expense in expenses) {
    if (expense.deleted) continue;
    final payer = effectiveUserId(users, expense.paidBy);
    for (final entry in expense.splits.entries) {
      final debtor = effectiveUserId(users, entry.key);
      if (debtor == payer) continue; // R7: no self-debt
      add(debtor, payer, entry.value);
    }
  }

  for (final settlement in settlements) {
    if (!settlementBalanceApplied(settlement.status)) continue;
    final from = effectiveUserId(users, settlement.from);
    final to = effectiveUserId(users, settlement.to);
    if (from == to) continue;
    add(from, to, -settlement.amount);
  }

  final result = <Transfer>[];
  final seenPairs = <String>{};
  for (final key in directed.keys) {
    final parts = key.split(' ');
    final x = parts[0], y = parts[1];
    final lo = x.compareTo(y) < 0 ? x : y;
    final hi = x.compareTo(y) < 0 ? y : x;
    final pairKey = '$lo $hi';
    if (!seenPairs.add(pairKey)) continue;
    final netLoToHi = (directed['$lo $hi'] ?? 0) - (directed['$hi $lo'] ?? 0);
    if (netLoToHi > 0) {
      result.add(Transfer(from: lo, to: hi, amount: netLoToHi));
    } else if (netLoToHi < 0) {
      result.add(Transfer(from: hi, to: lo, amount: -netLoToHi));
    }
  }
  result.sort((a, b) {
    final byFrom = a.from.compareTo(b.from);
    return byFrom != 0 ? byFrom : a.to.compareTo(b.to);
  });
  return result;
}

/// D6 invariant #1: the books balance — nets sum to zero.
void assertConservation(Map<String, int> net) {
  final sum = net.values.fold<int>(0, (acc, v) => acc + v);
  if (sum != 0) {
    throw EngineError(EngineError.splitSumMismatch, 'conservation violated: sum = $sum');
  }
}

void _assertSplitsSum(ExpenseRecord expense) {
  var sum = 0;
  for (final share in expense.splits.values) {
    if (share < 0) throw EngineError(EngineError.negativeShare, expense.id);
    sum += share;
  }
  if (sum != expense.amountTotal) {
    throw EngineError(EngineError.splitSumMismatch, expense.id);
  }
}
