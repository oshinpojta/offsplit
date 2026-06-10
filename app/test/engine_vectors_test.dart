/// Golden vector runner (X1). Runs the exact same JSON fixtures as the TS
/// engine (engine-vectors/); any behavioral change starts in the vectors.
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:offsplit/engine/engine.dart';

// flutter test runs with CWD = app/, so the vectors live one level up.
const vectorsDir = '../engine-vectors';

void main() {
  final files = Directory(vectorsDir)
      .listSync(recursive: true)
      .whereType<File>()
      .where((f) => f.path.endsWith('.json'))
      .toList()
    ..sort((a, b) => a.path.compareTo(b.path));

  test('vector files are present', () {
    expect(files.length, greaterThanOrEqualTo(5));
  });

  for (final file in files) {
    final doc = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
    final suite = doc['suite'] as String;
    final cases = (doc['cases'] as List).cast<Map<String, dynamic>>();

    group(suite, () {
      for (final c in cases) {
        test(c['name'] as String, () {
          switch (c['kind'] as String) {
            case 'split':
              _runSplit(c);
            case 'scenario':
              _runScenario(c);
            case 'transition':
              _runTransition(c);
            case 'balance_effect':
              expect(
                settlementBalanceApplied(c['status'] as String),
                (c['expect'] as Map)['applied'] as bool,
              );
            default:
              fail('unknown case kind: ${c['kind']}');
          }
        });
      }
    });
  }
}

void _expectEngineError(void Function() run, String code) {
  try {
    run();
    fail('expected EngineError $code, nothing thrown');
  } on EngineError catch (e) {
    expect(e.code, code);
  }
}

void _runSplit(Map<String, dynamic> c) {
  final participants = [
    for (final p in (c['participants'] as List).cast<Map<String, dynamic>>())
      SplitParticipant(
        userId: p['user_id'] as String,
        amount: p['amount'] as int?,
        bp: p['bp'] as int?,
        weight: p['weight'] as int?,
      ),
  ];
  Map<String, int> run() => computeShares(
        splitType: c['split_type'] as String,
        amountTotal: c['amount_total'] as int,
        participants: participants,
      );

  final expected = c['expect'] as Map<String, dynamic>;
  if (expected.containsKey('error')) {
    _expectEngineError(run, expected['error'] as String);
    return;
  }
  final shares = run();
  expect(shares, (expected['shares'] as Map).cast<String, int>());
  expect(shares.values.fold<int>(0, (a, v) => a + v), c['amount_total'] as int);
}

void _runTransition(Map<String, dynamic> c) {
  final expected = c['expect'] as Map<String, dynamic>;
  String run() => applySettlementTransition(c['from'] as String, c['action'] as String);
  if (expected.containsKey('error')) {
    _expectEngineError(run, expected['error'] as String);
    return;
  }
  expect(run(), expected['status'] as String);
}

ExpenseRecord _expense(Map<String, dynamic> raw) => ExpenseRecord(
      id: raw['id'] as String,
      paidBy: raw['paid_by'] as String,
      amountTotal: raw['amount_total'] as int,
      splits: (raw['splits'] as Map).cast<String, int>(),
      deleted: raw['deleted'] as bool? ?? false,
    );

List<Map<String, dynamic>> _transfersToJson(List<Transfer> transfers) => [
      for (final t in transfers) {'from': t.from, 'to': t.to, 'amount': t.amount},
    ];

void _runScenario(Map<String, dynamic> c) {
  final users = <String, UserRecord>{
    for (final u in (c['users'] as List).cast<Map<String, dynamic>>())
      u['id'] as String: UserRecord(
        id: u['id'] as String,
        isGhost: u['ghost'] as bool? ?? false,
      ),
  };
  final expenses = [
    for (final e in (c['expenses'] as List).cast<Map<String, dynamic>>()) _expense(e),
  ];
  final settlements = [
    for (final s in (c['settlements'] as List).cast<Map<String, dynamic>>())
      SettlementRecord(
        id: s['id'] as String,
        from: s['from'] as String,
        to: s['to'] as String,
        amount: s['amount'] as int,
        status: s['status'] as String,
      ),
  ];
  final expected = c['expect'] as Map<String, dynamic>;

  void execute() {
    if (expected.containsKey('netBefore')) {
      expect(
        computeNetBalances(users, expenses, settlements),
        (expected['netBefore'] as Map).cast<String, int>(),
      );
    }
    for (final step in ((c['steps'] as List?) ?? const []).cast<Map<String, dynamic>>()) {
      switch (step['op'] as String) {
        case 'merge':
          final plan = planMerge(users, step['primary'] as String, step['merged'] as String);
          if (step['expect_noop'] as bool? ?? false) expect(plan.kind, 'noop');
          applyMergePlan(users, plan);
        case 'reverse':
          applyReverse(users, step['merged'] as String);
        case 'add_expense':
          expenses.add(_expense(step['expense'] as Map<String, dynamic>));
        default:
          fail('unknown step op: ${step['op']}');
      }
    }
  }

  if (expected.containsKey('error')) {
    _expectEngineError(execute, expected['error'] as String);
    return;
  }
  execute();

  final net = computeNetBalances(users, expenses, settlements);
  assertConservation(net);
  if (expected.containsKey('net')) {
    expect(net, (expected['net'] as Map).cast<String, int>());
  }
  if (expected.containsKey('transfers')) {
    expect(
      _transfersToJson(simplifyDebts(net)),
      (expected['transfers'] as List).cast<Map<String, dynamic>>(),
    );
  }
  if (expected.containsKey('pairwise')) {
    expect(
      _transfersToJson(computePairwiseDebts(users, expenses, settlements)),
      (expected['pairwise'] as List).cast<Map<String, dynamic>>(),
    );
  }
  if (expected.containsKey('users')) {
    for (final entry in (expected['users'] as Map<String, dynamic>).entries) {
      final user = users[entry.key];
      final fields = entry.value as Map<String, dynamic>;
      expect(user, isNotNull, reason: 'user ${entry.key}');
      if (fields.containsKey('status')) {
        expect(user!.status, fields['status'], reason: 'user ${entry.key} status');
      }
      if (fields.containsKey('merged_into')) {
        expect(user!.mergedInto, fields['merged_into'],
            reason: 'user ${entry.key} merged_into');
      }
    }
  }
}
