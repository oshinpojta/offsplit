/// Property/fuzz tests (D8, §15.4) — mirrors the TS suite exactly: same LCG,
/// same seeds, same generation logic, so both engines face identical cases.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:offsplit/engine/engine.dart';

/// Deterministic 32-bit LCG (Numerical Recipes constants). Mirrors the TS Lcg.
class Lcg {
  Lcg(this._state);
  int _state;

  /// integer in [0, bound)
  int nextInt(int bound) {
    _state = ((_state * 1664525) + 1013904223) & 0xFFFFFFFF;
    return _state % bound;
  }
}

const iterations = 1000;
const seed = 20260610;

String _uid(int j) => 'u${j.toString().padLeft(2, '0')}';

void main() {
  test('splits always sum to total and never go negative ($iterations random cases)', () {
    final rng = Lcg(seed);
    for (var i = 0; i < iterations; i++) {
      final n = 1 + rng.nextInt(10);
      final total = 1 + rng.nextInt(1000000000);
      final participants = <SplitParticipant>[];
      final kind = rng.nextInt(3);
      if (kind == 0) {
        for (var j = 0; j < n; j++) {
          participants.add(SplitParticipant(userId: _uid(j)));
        }
      } else if (kind == 1) {
        var remaining = 10000;
        for (var j = 0; j < n; j++) {
          final bp = j == n - 1 ? remaining : rng.nextInt(remaining + 1);
          remaining -= bp;
          participants.add(SplitParticipant(userId: _uid(j), bp: bp));
        }
      } else {
        for (var j = 0; j < n; j++) {
          participants.add(SplitParticipant(userId: _uid(j), weight: 1 + rng.nextInt(99)));
        }
      }
      final splitType = kind == 0 ? 'equal' : (kind == 1 ? 'percent' : 'shares');
      final shares =
          computeShares(splitType: splitType, amountTotal: total, participants: participants);
      expect(shares.length, n);
      var sum = 0;
      for (final v in shares.values) {
        expect(v, greaterThanOrEqualTo(0));
        sum += v;
      }
      expect(sum, total);
    }
  });

  test('random ledgers conserve to zero and simplify within n-1 ($iterations cases)', () {
    final rng = Lcg(seed + 1);
    for (var i = 0; i < iterations; i++) {
      final memberCount = 2 + rng.nextInt(7);
      final memberIds = [for (var j = 0; j < memberCount; j++) _uid(j)];
      final users = <String, UserRecord>{
        for (final id in memberIds) id: UserRecord(id: id),
      };

      final expenses = <ExpenseRecord>[];
      final expenseCount = 1 + rng.nextInt(8);
      for (var e = 0; e < expenseCount; e++) {
        final payer = memberIds[rng.nextInt(memberCount)];
        final participantCount = 1 + rng.nextInt(memberCount);
        final start = rng.nextInt(memberCount);
        final chosen = [
          for (var k = 0; k < participantCount; k++) memberIds[(start + k) % memberCount],
        ];
        final total = 1 + rng.nextInt(100000);
        final shares = computeShares(
          splitType: 'equal',
          amountTotal: total,
          participants: [for (final id in chosen) SplitParticipant(userId: id)],
        );
        expenses.add(ExpenseRecord(
          id: 'e$e',
          paidBy: payer,
          amountTotal: total,
          splits: shares,
        ));
      }

      final net = computeNetBalances(users, expenses, []);
      assertConservation(net);

      final transfers = simplifyDebts(net);
      final nonZero = net.values.where((v) => v != 0).length;
      expect(transfers.length, lessThanOrEqualTo(nonZero > 0 ? nonZero - 1 : 0));

      final remaining = Map<String, int>.from(net);
      for (final t in transfers) {
        expect(t.amount, greaterThan(0));
        remaining[t.from] = (remaining[t.from] ?? 0) + t.amount;
        remaining[t.to] = (remaining[t.to] ?? 0) - t.amount;
      }
      for (final v in remaining.values) {
        expect(v, 0);
      }

      // determinism: recomputation yields the identical plan
      expect(simplifyDebts(net), transfers);
    }
  });
}
