/// Sprint 2 gate: the full ledger flow works against a local DB with no
/// network anywhere — create group → add ghosts → log expenses → see raw +
/// simplified balances (§14 acceptance, offline part). Also verifies the
/// incremental balance cache never diverges from a fresh recompute (D6) and
/// that the cache is merge-agnostic (raw ids + read-time resolution, M4).
library;

import 'package:drift/drift.dart' hide isNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:offsplit/data/db.dart';
import 'package:offsplit/data/ledger_repository.dart';
import 'package:offsplit/engine/engine.dart' as engine;

void main() {
  late AppDatabase db;
  late LedgerRepository repo;
  late int idCounter;
  late int tick;

  setUp(() {
    db = AppDatabase(NativeDatabase.memory());
    idCounter = 0;
    tick = 1000;
    repo = LedgerRepository(
      db,
      idGenerator: () => 'id-${(++idCounter).toString().padLeft(3, '0')}',
      clock: () => ++tick,
    );
  });

  tearDown(() async {
    await db.close();
  });

  Future<(User alice, User bob, User chandra, Group group)> seedGroup() async {
    final alice = await repo.createUser(displayName: 'Alice');
    final group = await repo.createGroup(name: 'Flat 4B', createdBy: alice.id);
    final bob = await repo.createGhost(groupId: group.id, displayName: 'Bob');
    final chandra = await repo.createGhost(groupId: group.id, displayName: 'Chandra');
    return (alice, bob, chandra, group);
  }

  test('airplane-mode flow: group → ghosts → expenses → raw + simplified balances', () async {
    final (alice, bob, chandra, group) = await seedGroup();

    // e1: Alice paid 300, equal three-way.
    await repo.addExpense(
      groupId: group.id,
      description: 'Groceries',
      amountTotal: 300,
      paidBy: alice.id,
      splitType: 'equal',
      participants: [
        engine.SplitParticipant(userId: alice.id),
        engine.SplitParticipant(userId: bob.id),
        engine.SplitParticipant(userId: chandra.id),
      ],
      createdBy: alice.id,
    );
    // e2: Bob paid 90, exact — Alice 30, Bob 60.
    await repo.addExpense(
      groupId: group.id,
      description: 'Auto',
      amountTotal: 90,
      paidBy: bob.id,
      splitType: 'exact',
      participants: [
        engine.SplitParticipant(userId: alice.id, amount: 30),
        engine.SplitParticipant(userId: bob.id, amount: 60),
      ],
      createdBy: alice.id,
    );

    final view = await repo.groupBalances(group.id);
    expect(view.net['INR'], {alice.id: 170, bob.id: -70, chandra.id: -100});
    expect(view.simplified['INR'], [
      engine.Transfer(from: chandra.id, to: alice.id, amount: 100),
      engine.Transfer(from: bob.id, to: alice.id, amount: 70),
    ]);
    expect(view.pairwise['INR'], [
      engine.Transfer(from: bob.id, to: alice.id, amount: 70),
      engine.Transfer(from: chandra.id, to: alice.id, amount: 100),
    ]);
    expect(await repo.auditBalanceCache(group.id), isTrue);
  });

  test('whole-document expense edit (S4) reverses and reapplies cache deltas', () async {
    final (alice, bob, chandra, group) = await seedGroup();
    await repo.addExpense(
      groupId: group.id,
      description: 'Groceries',
      amountTotal: 300,
      paidBy: alice.id,
      splitType: 'equal',
      participants: [
        engine.SplitParticipant(userId: alice.id),
        engine.SplitParticipant(userId: bob.id),
        engine.SplitParticipant(userId: chandra.id),
      ],
      createdBy: alice.id,
    );
    final e2 = await repo.addExpense(
      groupId: group.id,
      description: 'Auto',
      amountTotal: 90,
      paidBy: bob.id,
      splitType: 'exact',
      participants: [
        engine.SplitParticipant(userId: alice.id, amount: 30),
        engine.SplitParticipant(userId: bob.id, amount: 60),
      ],
      createdBy: alice.id,
    );

    await repo.updateExpense(
      expenseId: e2.id,
      description: 'Auto (corrected)',
      amountTotal: 120,
      splitType: 'equal',
      participants: [
        engine.SplitParticipant(userId: alice.id),
        engine.SplitParticipant(userId: bob.id),
      ],
    );

    final view = await repo.groupBalances(group.id);
    expect(view.net['INR'], {alice.id: 140, bob.id: -40, chandra.id: -100});
    expect(await repo.auditBalanceCache(group.id), isTrue);
  });

  test('soft delete reverses cache and is idempotent; tombstone hides the row', () async {
    final (alice, bob, chandra, group) = await seedGroup();
    await repo.addExpense(
      groupId: group.id,
      description: 'Groceries',
      amountTotal: 300,
      paidBy: alice.id,
      splitType: 'equal',
      participants: [
        engine.SplitParticipant(userId: alice.id),
        engine.SplitParticipant(userId: bob.id),
        engine.SplitParticipant(userId: chandra.id),
      ],
      createdBy: alice.id,
    );
    final e2 = await repo.addExpense(
      groupId: group.id,
      description: 'Auto',
      amountTotal: 90,
      paidBy: bob.id,
      splitType: 'exact',
      participants: [
        engine.SplitParticipant(userId: alice.id, amount: 30),
        engine.SplitParticipant(userId: bob.id, amount: 60),
      ],
      createdBy: alice.id,
    );

    await repo.softDeleteExpense(e2.id);
    await repo.softDeleteExpense(e2.id); // idempotent

    final view = await repo.groupBalances(group.id);
    expect(view.net['INR'], {alice.id: 200, bob.id: -100, chandra.id: -100});
    expect(await repo.auditBalanceCache(group.id), isTrue);

    // a deleted expense rejects edits (local mirror of S6)
    expect(
      () => repo.updateExpense(
        expenseId: e2.id,
        description: 'zombie',
        amountTotal: 10,
        splitType: 'equal',
        participants: [engine.SplitParticipant(userId: alice.id)],
      ),
      throwsA(isA<LedgerException>()),
    );
  });

  test('settlement lifecycle: M10 cache effects + S5 guarded transitions', () async {
    final (alice, bob, chandra, group) = await seedGroup();
    await repo.addExpense(
      groupId: group.id,
      description: 'Groceries',
      amountTotal: 300,
      paidBy: alice.id,
      splitType: 'equal',
      participants: [
        engine.SplitParticipant(userId: alice.id),
        engine.SplitParticipant(userId: bob.id),
        engine.SplitParticipant(userId: chandra.id),
      ],
      createdBy: alice.id,
    );

    final settlement = await repo.createSettlement(
      groupId: group.id,
      fromUser: bob.id,
      toUser: alice.id,
      amount: 100,
    );

    // pending: no balance effect
    var view = await repo.groupBalances(group.id);
    expect(view.net['INR'], {alice.id: 200, bob.id: -100, chandra.id: -100});

    // illegal: confirm before marked_paid — rejected, nothing changes
    expect(
      () => repo.settlementAction(
          settlementId: settlement.id, action: 'confirm', actorId: alice.id),
      throwsA(isA<engine.EngineError>()),
    );
    view = await repo.groupBalances(group.id);
    expect(view.net['INR'], {alice.id: 200, bob.id: -100, chandra.id: -100});

    // mark_paid applies (M10)
    await repo.settlementAction(
        settlementId: settlement.id, action: 'mark_paid', actorId: bob.id);
    view = await repo.groupBalances(group.id);
    expect(view.net['INR'], {alice.id: 100, bob.id: 0, chandra.id: -100});
    expect(await repo.auditBalanceCache(group.id), isTrue);

    // dispute reverts
    await repo.settlementAction(
        settlementId: settlement.id, action: 'dispute', actorId: alice.id);
    view = await repo.groupBalances(group.id);
    expect(view.net['INR'], {alice.id: 200, bob.id: -100, chandra.id: -100});

    // reset → pending → mark_paid → confirm stays applied
    await repo.settlementAction(
        settlementId: settlement.id, action: 'reset', actorId: bob.id);
    await repo.settlementAction(
        settlementId: settlement.id, action: 'mark_paid', actorId: bob.id);
    await repo.settlementAction(
        settlementId: settlement.id, action: 'confirm', actorId: alice.id);
    view = await repo.groupBalances(group.id);
    expect(view.net['INR'], {alice.id: 100, bob.id: 0, chandra.id: -100});
    expect(await repo.auditBalanceCache(group.id), isTrue);
  });

  test('merge-agnostic cache: local merge changes the view, not the cache (M4/A0)', () async {
    final (alice, bob, _, group) = await seedGroup();
    await repo.addExpense(
      groupId: group.id,
      description: 'Rent',
      amountTotal: 200,
      paidBy: alice.id,
      splitType: 'equal',
      participants: [
        engine.SplitParticipant(userId: alice.id),
        engine.SplitParticipant(userId: bob.id),
      ],
      createdBy: alice.id,
    );

    // Simulate a merge arriving via sync: bob tombstoned into alice.
    await (db.update(db.users)..where((u) => u.id.equals(bob.id))).write(
      UsersCompanion(status: const Value('merged'), mergedInto: Value(alice.id)),
    );

    final view = await repo.groupBalances(group.id);
    expect(view.net['INR'], {alice.id: 0}); // self-debt nets to zero (R7)
    expect(view.pairwise['INR'], isEmpty); // self-pair filtered
    expect(view.simplified['INR'], isEmpty);

    // The cache itself was never touched and still matches the raw rows.
    expect(await repo.auditBalanceCache(group.id), isTrue);
  });

  test('validation: non-member participant and self-settlement fail closed', () async {
    final (alice, _, _, group) = await seedGroup();
    final stranger = await repo.createUser(displayName: 'Stranger');

    expect(
      () => repo.addExpense(
        groupId: group.id,
        description: 'Nope',
        amountTotal: 100,
        paidBy: alice.id,
        splitType: 'equal',
        participants: [
          engine.SplitParticipant(userId: alice.id),
          engine.SplitParticipant(userId: stranger.id),
        ],
        createdBy: alice.id,
      ),
      throwsA(isA<LedgerException>()),
    );

    expect(
      () => repo.createSettlement(
        groupId: group.id,
        fromUser: alice.id,
        toUser: alice.id,
        amount: 50,
      ),
      throwsA(isA<LedgerException>()),
    );
  });
}
