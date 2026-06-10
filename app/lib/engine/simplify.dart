import 'types.dart';

/// Greedy min-cash-flow debt simplification (§7.3, M11). Deterministic:
/// largest creditor matched with largest debtor, ties broken by user_id
/// ascending. Produces <= n-1 transfers that settle the nets exactly.
List<Transfer> simplifyDebts(Map<String, int> net) {
  final creditors = <({String id, int amount})>[];
  final debtors = <({String id, int amount})>[];
  for (final entry in net.entries) {
    if (entry.value > 0) {
      creditors.add((id: entry.key, amount: entry.value));
    } else if (entry.value < 0) {
      debtors.add((id: entry.key, amount: -entry.value));
    }
  }

  int pickMax(List<({String id, int amount})> list) {
    var best = 0;
    for (var i = 1; i < list.length; i++) {
      final candidate = list[i];
      final current = list[best];
      if (candidate.amount > current.amount ||
          (candidate.amount == current.amount && candidate.id.compareTo(current.id) < 0)) {
        best = i;
      }
    }
    return best;
  }

  final transfers = <Transfer>[];
  while (creditors.isNotEmpty && debtors.isNotEmpty) {
    final creditorIndex = pickMax(creditors);
    final debtorIndex = pickMax(debtors);
    final creditor = creditors[creditorIndex];
    final debtor = debtors[debtorIndex];
    final amount = creditor.amount < debtor.amount ? creditor.amount : debtor.amount;
    transfers.add(Transfer(from: debtor.id, to: creditor.id, amount: amount));
    final newCreditor = (id: creditor.id, amount: creditor.amount - amount);
    final newDebtor = (id: debtor.id, amount: debtor.amount - amount);
    if (newCreditor.amount == 0) {
      creditors.removeAt(creditorIndex);
    } else {
      creditors[creditorIndex] = newCreditor;
    }
    if (newDebtor.amount == 0) {
      debtors.removeAt(debtorIndex);
    } else {
      debtors[debtorIndex] = newDebtor;
    }
  }

  return transfers;
}
