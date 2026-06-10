/// All money amounts are integer paise (M7).
library;

const int maxAmountPaise = 1000000000000; // ₹100 crore (D2)
const int maxParticipants = 50; // per expense (D2)
const int bpTotal = 10000; // percent splits arrive as integer basis points (M8)

class UserRecord {
  const UserRecord({
    required this.id,
    this.status = 'active',
    this.mergedInto,
    this.isGhost = false,
  });

  final String id;
  final String status; // 'active' | 'merged'
  final String? mergedInto;
  final bool isGhost;

  UserRecord copyWith({String? status, String? Function()? mergedInto}) => UserRecord(
        id: id,
        status: status ?? this.status,
        mergedInto: mergedInto != null ? mergedInto() : this.mergedInto,
        isGhost: isGhost,
      );
}

class SplitParticipant {
  const SplitParticipant({required this.userId, this.amount, this.bp, this.weight});

  final String userId;

  /// exact: the participant's share in paise
  final int? amount;

  /// percent: integer basis points (Σ must be 10000)
  final int? bp;

  /// shares: integer weight >= 1
  final int? weight;
}

class ExpenseRecord {
  const ExpenseRecord({
    required this.id,
    required this.paidBy,
    required this.amountTotal,
    required this.splits,
    this.deleted = false,
  });

  final String id;
  final String paidBy;
  final int amountTotal;

  /// userId -> share in paise; Σ must equal amountTotal
  final Map<String, int> splits;
  final bool deleted;
}

class SettlementRecord {
  const SettlementRecord({
    required this.id,
    required this.from,
    required this.to,
    required this.amount,
    required this.status,
  });

  final String id;
  final String from;
  final String to;
  final int amount;
  final String status; // 'pending' | 'marked_paid' | 'confirmed' | 'disputed'
}

class Transfer {
  const Transfer({required this.from, required this.to, required this.amount});

  final String from;
  final String to;
  final int amount;

  @override
  bool operator ==(Object other) =>
      other is Transfer && other.from == from && other.to == to && other.amount == amount;

  @override
  int get hashCode => Object.hash(from, to, amount);

  @override
  String toString() => 'Transfer($from -> $to: $amount)';
}
