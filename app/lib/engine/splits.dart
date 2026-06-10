import 'errors.dart';
import 'types.dart';

/// Compute per-participant shares for an expense (M8).
///
/// One deterministic rounding rule for equal/percent/shares:
/// largest-remainder, ties broken by user_id ascending. Exact splits must
/// sum precisely or are rejected — never auto-fixed.
///
/// Postcondition (M7): Σ(shares) == amountTotal, every share >= 0.
/// Dart ints are 64-bit: total * bp tops out at 10^16, well inside range
/// (the TS engine uses BigInt for the same product).
Map<String, int> computeShares({
  required String splitType,
  required int amountTotal,
  required List<SplitParticipant> participants,
}) {
  if (amountTotal <= 0) throw const EngineError(EngineError.invalidAmount);
  if (amountTotal > maxAmountPaise) {
    throw const EngineError(EngineError.amountOutOfBounds);
  }
  if (participants.isEmpty) throw const EngineError(EngineError.noParticipants);
  if (participants.length > maxParticipants) {
    throw const EngineError(EngineError.tooManyParticipants);
  }
  final ids = <String>{};
  for (final p in participants) {
    if (!ids.add(p.userId)) {
      throw EngineError(EngineError.duplicateParticipant, p.userId);
    }
  }

  switch (splitType) {
    case 'exact':
      return _exactShares(amountTotal, participants);
    case 'equal':
      return _largestRemainder(
        amountTotal,
        [for (final p in participants) (userId: p.userId, numerator: 1)],
        participants.length,
      );
    case 'percent':
      var sum = 0;
      for (final p in participants) {
        final bp = p.bp;
        if (bp == null || bp < 0 || bp > bpTotal) {
          throw EngineError(EngineError.invalidPercent, p.userId);
        }
        sum += bp;
      }
      if (sum != bpTotal) throw const EngineError(EngineError.percentSumMismatch);
      return _largestRemainder(
        amountTotal,
        [for (final p in participants) (userId: p.userId, numerator: p.bp!)],
        bpTotal,
      );
    case 'shares':
      var totalWeight = 0;
      for (final p in participants) {
        final weight = p.weight;
        if (weight == null || weight < 1) {
          throw EngineError(EngineError.invalidWeight, p.userId);
        }
        totalWeight += weight;
      }
      return _largestRemainder(
        amountTotal,
        [for (final p in participants) (userId: p.userId, numerator: p.weight!)],
        totalWeight,
      );
    default:
      throw ArgumentError.value(splitType, 'splitType');
  }
}

Map<String, int> _exactShares(int amountTotal, List<SplitParticipant> participants) {
  var sum = 0;
  for (final p in participants) {
    final amount = p.amount;
    if (amount == null || amount < 0) {
      throw EngineError(EngineError.negativeShare, p.userId);
    }
    sum += amount;
  }
  if (sum != amountTotal) throw const EngineError(EngineError.splitSumMismatch);
  return {for (final p in participants) p.userId: p.amount!};
}

/// Largest-remainder apportionment over ideal shares total*numerator/denominator.
Map<String, int> _largestRemainder(
  int total,
  List<({String userId, int numerator})> entries,
  int denominator,
) {
  final computed = [
    for (final e in entries)
      (
        userId: e.userId,
        floor: (total * e.numerator) ~/ denominator,
        remainder: (total * e.numerator) % denominator,
      ),
  ];

  var leftover = total - computed.fold<int>(0, (acc, c) => acc + c.floor);

  final order = [...computed]..sort((x, y) {
    if (x.remainder != y.remainder) return y.remainder.compareTo(x.remainder);
    return x.userId.compareTo(y.userId);
  });

  final bonus = <String, int>{};
  for (final entry in order) {
    if (leftover == 0) break;
    bonus[entry.userId] = 1;
    leftover -= 1;
  }

  final shares = <String, int>{
    for (final c in computed) c.userId: c.floor + (bonus[c.userId] ?? 0),
  };

  // M7 postcondition — belt and braces.
  final sum = shares.values.fold<int>(0, (acc, v) => acc + v);
  if (sum != total) {
    throw const EngineError(EngineError.splitSumMismatch, 'internal rounding error');
  }
  return shares;
}
