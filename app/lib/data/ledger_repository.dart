/// Offline ledger operations over the local drift DB (§10.1: the client is
/// fully functional with no network). Every mutation runs in ONE transaction
/// together with its incremental balance-cache update — the cache is never
/// allowed to drift from the rows within a committed state (L2).
///
/// The `member_balances` cache stores RAW per-user nets (no identity
/// resolution): net is linear, so the effective view is just an aggregation
/// of raw nets through `effectiveUserId` at read time (M4). Merges therefore
/// never touch the cache at all.
library;

import 'package:drift/drift.dart';
import 'package:uuid/uuid.dart';

import '../engine/engine.dart' as engine;
import 'db.dart';

class LedgerException implements Exception {
  const LedgerException(this.code, [this.detail]);
  final String code;
  final String? detail;

  static const notFound = 'not_found';
  static const notAMember = 'not_a_member';
  static const selfSettlement = 'self_settlement';

  @override
  String toString() => 'LedgerException($code${detail == null ? '' : ': $detail'})';
}

/// Read model returned by [LedgerRepository.groupBalances].
class GroupBalancesView {
  const GroupBalancesView({
    required this.net,
    required this.simplified,
    required this.pairwise,
  });

  /// currency -> effective user id -> net paise (positive = owed to them)
  final Map<String, Map<String, int>> net;

  /// currency -> minimal transfer plan (M11) — "who to pay"
  final Map<String, List<engine.Transfer>> simplified;

  /// currency -> raw netted pair debts (§7.3) — "who you actually spent with"
  final Map<String, List<engine.Transfer>> pairwise;
}

class LedgerRepository {
  LedgerRepository(this.db, {String Function()? idGenerator, int Function()? clock})
      : _newId = idGenerator ?? const Uuid().v4,
        _now = clock ?? (() => DateTime.now().millisecondsSinceEpoch);

  final AppDatabase db;
  final String Function() _newId;
  final int Function() _now;

  // ── Users / groups / membership ────────────────────────────────────────

  Future<User> createUser({
    required String displayName,
    String? upiId,
    bool ghost = false,
    String? id,
  }) async {
    final now = _now();
    final companion = UsersCompanion.insert(
      id: id ?? _newId(),
      displayName: displayName,
      defaultUpiId: Value(upiId),
      isGhost: Value(ghost),
      createdAt: now,
      updatedAt: now,
    );
    await db.into(db.users).insert(companion);
    return _userById(companion.id.value);
  }

  Future<Group> createGroup({
    required String name,
    required String createdBy,
    String type = 'standard',
    String currency = 'INR',
  }) async {
    await _userById(createdBy); // must exist
    final now = _now();
    final id = _newId();
    return db.transaction(() async {
      await db.into(db.groups).insert(GroupsCompanion.insert(
            id: id,
            name: name,
            type: Value(type),
            defaultCurrency: Value(currency),
            createdBy: createdBy,
            createdAt: now,
            updatedAt: now,
          ));
      await db.into(db.groupMembers).insert(GroupMembersCompanion.insert(
            groupId: id,
            userId: createdBy,
            role: const Value('owner'),
            joinedAt: now,
          ));
      return (db.select(db.groups)..where((g) => g.id.equals(id))).getSingle();
    });
  }

  Future<void> addMember({
    required String groupId,
    required String userId,
    String role = 'member',
  }) async {
    await _groupById(groupId);
    await _userById(userId);
    await db.into(db.groupMembers).insert(GroupMembersCompanion.insert(
          groupId: groupId,
          userId: userId,
          role: Value(role),
          joinedAt: _now(),
        ));
  }

  /// Ghost member (§6.1): a user with no login, splittable-with immediately.
  /// (The claim token is minted server-side in Sprint 5/7.)
  Future<User> createGhost({
    required String groupId,
    required String displayName,
    String? upiId,
  }) async {
    await _groupById(groupId);
    return db.transaction(() async {
      final ghost = await createUser(displayName: displayName, upiId: upiId, ghost: true);
      await db.into(db.groupMembers).insert(GroupMembersCompanion.insert(
            groupId: groupId,
            userId: ghost.id,
            joinedAt: _now(),
          ));
      return ghost;
    });
  }

  // ── Expenses ───────────────────────────────────────────────────────────

  /// Create an expense. Shares are computed by the engine (M8) and the
  /// balance cache is updated in the SAME transaction.
  Future<Expense> addExpense({
    required String groupId,
    required String description,
    required int amountTotal,
    required String paidBy,
    required String splitType,
    required List<engine.SplitParticipant> participants,
    required String createdBy,
    String? currency,
    int? txnDate,
    String? id,
  }) async {
    final group = await _groupById(groupId);
    final resolvedCurrency = currency ?? group.defaultCurrency;
    await _assertMember(groupId, paidBy);
    for (final p in participants) {
      await _assertMember(groupId, p.userId);
    }
    final shares = engine.computeShares(
      splitType: splitType,
      amountTotal: amountTotal,
      participants: participants,
    );
    final now = _now();
    final expenseId = id ?? _newId();

    return db.transaction(() async {
      await db.into(db.expenses).insert(ExpensesCompanion.insert(
            id: expenseId,
            groupId: groupId,
            description: description,
            amountTotal: amountTotal,
            currency: Value(resolvedCurrency),
            paidBy: paidBy,
            splitType: splitType,
            txnDate: txnDate ?? now,
            createdBy: createdBy,
            createdAt: now,
            updatedAt: now,
          ));
      for (final entry in shares.entries) {
        await db.into(db.expenseSplits).insert(ExpenseSplitsCompanion.insert(
              expenseId: expenseId,
              userId: entry.key,
              shareAmount: entry.value,
            ));
      }
      await _applyExpenseToCache(groupId, resolvedCurrency, paidBy, shares, sign: 1);
      return (db.select(db.expenses)..where((e) => e.id.equals(expenseId))).getSingle();
    });
  }

  /// Whole-document edit (S4): the new splits replace the old ones entirely;
  /// cache deltas are reversed and reapplied in one transaction.
  Future<Expense> updateExpense({
    required String expenseId,
    required String description,
    required int amountTotal,
    required String splitType,
    required List<engine.SplitParticipant> participants,
    String? paidBy,
    int? txnDate,
  }) async {
    final existing = await _expenseById(expenseId);
    if (existing.deletedAt != null) {
      throw const LedgerException(LedgerException.notFound, 'expense deleted');
    }
    final newPaidBy = paidBy ?? existing.paidBy;
    await _assertMember(existing.groupId, newPaidBy);
    for (final p in participants) {
      await _assertMember(existing.groupId, p.userId);
    }
    final newShares = engine.computeShares(
      splitType: splitType,
      amountTotal: amountTotal,
      participants: participants,
    );
    final now = _now();

    return db.transaction(() async {
      final oldShares = await _sharesOf(expenseId);
      await _applyExpenseToCache(
          existing.groupId, existing.currency, existing.paidBy, oldShares,
          sign: -1);

      await (db.delete(db.expenseSplits)..where((s) => s.expenseId.equals(expenseId))).go();
      await (db.update(db.expenses)..where((e) => e.id.equals(expenseId))).write(
        ExpensesCompanion(
          description: Value(description),
          amountTotal: Value(amountTotal),
          splitType: Value(splitType),
          paidBy: Value(newPaidBy),
          txnDate: txnDate != null ? Value(txnDate) : const Value.absent(),
          updatedAt: Value(now),
        ),
      );
      for (final entry in newShares.entries) {
        await db.into(db.expenseSplits).insert(ExpenseSplitsCompanion.insert(
              expenseId: expenseId,
              userId: entry.key,
              shareAmount: entry.value,
            ));
      }
      await _applyExpenseToCache(
          existing.groupId, existing.currency, newPaidBy, newShares,
          sign: 1);
      return (db.select(db.expenses)..where((e) => e.id.equals(expenseId))).getSingle();
    });
  }

  /// Soft delete (§10.2): tombstone the row, reverse its cache deltas.
  Future<void> softDeleteExpense(String expenseId) async {
    final existing = await _expenseById(expenseId);
    if (existing.deletedAt != null) return; // already deleted — idempotent
    final now = _now();
    await db.transaction(() async {
      final shares = await _sharesOf(expenseId);
      await (db.update(db.expenses)..where((e) => e.id.equals(expenseId))).write(
        ExpensesCompanion(deletedAt: Value(now), updatedAt: Value(now)),
      );
      await _applyExpenseToCache(
          existing.groupId, existing.currency, existing.paidBy, shares,
          sign: -1);
    });
  }

  // ── Settlements ────────────────────────────────────────────────────────

  Future<Settlement> createSettlement({
    required String groupId,
    required String fromUser,
    required String toUser,
    required int amount,
    String? currency,
    String method = 'upi',
    String? id,
  }) async {
    final group = await _groupById(groupId);
    await _assertMember(groupId, fromUser);
    await _assertMember(groupId, toUser);
    if (fromUser == toUser) {
      throw const LedgerException(LedgerException.selfSettlement);
    }
    if (amount <= 0) throw const engine.EngineError(engine.EngineError.invalidAmount);
    final now = _now();
    final settlementId = id ?? _newId();
    await db.into(db.settlements).insert(SettlementsCompanion.insert(
          id: settlementId,
          groupId: groupId,
          fromUser: fromUser,
          toUser: toUser,
          amount: amount,
          currency: Value(currency ?? group.defaultCurrency),
          method: Value(method),
          createdAt: now,
          updatedAt: now,
        ));
    return _settlementById(settlementId);
  }

  /// Guarded state-machine transition (S5 — never LWW). Balance-cache effect
  /// follows M10: apply on entering marked_paid, reverse on entering disputed.
  Future<Settlement> settlementAction({
    required String settlementId,
    required String action,
    required String actorId,
  }) async {
    final settlement = await _settlementById(settlementId);
    final next = engine.applySettlementTransition(settlement.status, action);
    final now = _now();

    return db.transaction(() async {
      final companion = SettlementsCompanion(
        status: Value(next),
        updatedAt: Value(now),
        markedPaidBy: action == 'mark_paid' ? Value(actorId) : const Value.absent(),
        markedPaidAt: action == 'mark_paid' ? Value(now) : const Value.absent(),
        confirmedBy: action == 'confirm' ? Value(actorId) : const Value.absent(),
        confirmedAt: action == 'confirm' ? Value(now) : const Value.absent(),
      );
      await (db.update(db.settlements)..where((s) => s.id.equals(settlementId)))
          .write(companion);

      final wasApplied = engine.settlementBalanceApplied(settlement.status);
      final isApplied = engine.settlementBalanceApplied(next);
      if (!wasApplied && isApplied) {
        await _applySettlementToCache(settlement, sign: 1);
      } else if (wasApplied && !isApplied) {
        await _applySettlementToCache(settlement, sign: -1);
      }
      return _settlementById(settlementId);
    });
  }

  // ── Balance reads (M4: resolve identity here, and only here) ───────────

  Future<GroupBalancesView> groupBalances(String groupId) async {
    await _groupById(groupId);
    final users = await _engineUsers();

    // Effective nets: aggregate the RAW cache through effectiveUserId.
    final cacheRows = await (db.select(db.memberBalances)
          ..where((b) => b.groupId.equals(groupId)))
        .get();
    final net = <String, Map<String, int>>{};
    for (final row in cacheRows) {
      final effective = engine.effectiveUserId(users, row.userId);
      final byCurrency = net.putIfAbsent(row.currency, () => <String, int>{});
      byCurrency[effective] = (byCurrency[effective] ?? 0) + row.netAmount;
    }

    final simplified = <String, List<engine.Transfer>>{};
    for (final entry in net.entries) {
      simplified[entry.key] = engine.simplifyDebts(entry.value);
    }

    // Raw pairwise view straight from the immutable rows.
    final expenses = await _engineExpenses(groupId);
    final settlements = await _engineSettlements(groupId);
    final currencies = <String>{
      ...expenses.keys,
      ...settlements.keys,
    };
    final pairwise = <String, List<engine.Transfer>>{};
    for (final currency in currencies) {
      pairwise[currency] = engine.computePairwiseDebts(
        users,
        expenses[currency] ?? const [],
        settlements[currency] ?? const [],
      );
    }

    return GroupBalancesView(net: net, simplified: simplified, pairwise: pairwise);
  }

  /// D5: rebuild the cache for a group from the immutable rows. Idempotent.
  Future<void> rebuildBalanceCache(String groupId) async {
    await db.transaction(() async {
      final fresh = await _recomputeRawNets(groupId);
      await (db.delete(db.memberBalances)..where((b) => b.groupId.equals(groupId))).go();
      for (final currencyEntry in fresh.entries) {
        for (final userEntry in currencyEntry.value.entries) {
          await db.into(db.memberBalances).insert(MemberBalancesCompanion.insert(
                groupId: groupId,
                currency: currencyEntry.key,
                userId: userEntry.key,
                netAmount: userEntry.value,
              ));
        }
      }
    });
  }

  /// D6 client mini-audit: does the incremental cache match a fresh
  /// recompute (and do the books balance)? Run on group open; on `false`,
  /// call [rebuildBalanceCache] and report telemetry.
  Future<bool> auditBalanceCache(String groupId) async {
    final fresh = await _recomputeRawNets(groupId);
    final cacheRows = await (db.select(db.memberBalances)
          ..where((b) => b.groupId.equals(groupId)))
        .get();
    final cached = <String, Map<String, int>>{};
    for (final row in cacheRows) {
      cached.putIfAbsent(row.currency, () => <String, int>{})[row.userId] = row.netAmount;
    }
    // Compare ignoring zero entries (a zero net and an absent row are the same fact).
    if (!_netsEqual(fresh, cached)) return false;
    for (final byCurrency in fresh.values) {
      var sum = 0;
      for (final v in byCurrency.values) {
        sum += v;
      }
      if (sum != 0) return false; // conservation (D6 invariant #1)
    }
    return true;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  Future<User> _userById(String id) async {
    final user =
        await (db.select(db.users)..where((u) => u.id.equals(id))).getSingleOrNull();
    if (user == null) throw const LedgerException(LedgerException.notFound, 'user');
    return user;
  }

  Future<Group> _groupById(String id) async {
    final group = await (db.select(db.groups)
          ..where((g) => g.id.equals(id) & g.deletedAt.isNull()))
        .getSingleOrNull();
    if (group == null) throw const LedgerException(LedgerException.notFound, 'group');
    return group;
  }

  Future<Expense> _expenseById(String id) async {
    final expense =
        await (db.select(db.expenses)..where((e) => e.id.equals(id))).getSingleOrNull();
    if (expense == null) throw const LedgerException(LedgerException.notFound, 'expense');
    return expense;
  }

  Future<Settlement> _settlementById(String id) async {
    final settlement = await (db.select(db.settlements)..where((s) => s.id.equals(id)))
        .getSingleOrNull();
    if (settlement == null) {
      throw const LedgerException(LedgerException.notFound, 'settlement');
    }
    return settlement;
  }

  Future<void> _assertMember(String groupId, String userId) async {
    final row = await (db.select(db.groupMembers)
          ..where((m) => m.groupId.equals(groupId) & m.userId.equals(userId)))
        .getSingleOrNull();
    if (row == null) {
      throw LedgerException(LedgerException.notAMember, '$userId in $groupId');
    }
  }

  Future<Map<String, int>> _sharesOf(String expenseId) async {
    final rows = await (db.select(db.expenseSplits)
          ..where((s) => s.expenseId.equals(expenseId)))
        .get();
    return {for (final r in rows) r.userId: r.shareAmount};
  }

  Future<void> _applyExpenseToCache(
    String groupId,
    String currency,
    String paidBy,
    Map<String, int> shares, {
    required int sign,
  }) async {
    var total = 0;
    for (final entry in shares.entries) {
      total += entry.value;
      await _bumpCache(groupId, currency, entry.key, -entry.value * sign);
    }
    await _bumpCache(groupId, currency, paidBy, total * sign);
  }

  Future<void> _applySettlementToCache(Settlement settlement, {required int sign}) async {
    await _bumpCache(
        settlement.groupId, settlement.currency, settlement.fromUser, settlement.amount * sign);
    await _bumpCache(
        settlement.groupId, settlement.currency, settlement.toUser, -settlement.amount * sign);
  }

  Future<void> _bumpCache(String groupId, String currency, String userId, int delta) async {
    if (delta == 0) return;
    final existing = await (db.select(db.memberBalances)
          ..where((b) =>
              b.groupId.equals(groupId) &
              b.currency.equals(currency) &
              b.userId.equals(userId)))
        .getSingleOrNull();
    if (existing == null) {
      await db.into(db.memberBalances).insert(MemberBalancesCompanion.insert(
            groupId: groupId,
            currency: currency,
            userId: userId,
            netAmount: delta,
          ));
    } else {
      await (db.update(db.memberBalances)
            ..where((b) =>
                b.groupId.equals(groupId) &
                b.currency.equals(currency) &
                b.userId.equals(userId)))
          .write(MemberBalancesCompanion(netAmount: Value(existing.netAmount + delta)));
    }
  }

  Future<Map<String, engine.UserRecord>> _engineUsers() async {
    final rows = await db.select(db.users).get();
    return {
      for (final u in rows)
        u.id: engine.UserRecord(
          id: u.id,
          status: u.status,
          mergedInto: u.mergedInto,
          isGhost: u.isGhost,
        ),
    };
  }

  /// currency -> engine expense records (non-deleted) for a group.
  Future<Map<String, List<engine.ExpenseRecord>>> _engineExpenses(String groupId) async {
    final expenseRows = await (db.select(db.expenses)
          ..where((e) => e.groupId.equals(groupId) & e.deletedAt.isNull()))
        .get();
    final result = <String, List<engine.ExpenseRecord>>{};
    for (final row in expenseRows) {
      final shares = await _sharesOf(row.id);
      result.putIfAbsent(row.currency, () => []).add(engine.ExpenseRecord(
            id: row.id,
            paidBy: row.paidBy,
            amountTotal: row.amountTotal,
            splits: shares,
          ));
    }
    return result;
  }

  Future<Map<String, List<engine.SettlementRecord>>> _engineSettlements(
      String groupId) async {
    final rows = await (db.select(db.settlements)
          ..where((s) => s.groupId.equals(groupId)))
        .get();
    final result = <String, List<engine.SettlementRecord>>{};
    for (final row in rows) {
      result.putIfAbsent(row.currency, () => []).add(engine.SettlementRecord(
            id: row.id,
            from: row.fromUser,
            to: row.toUser,
            amount: row.amount,
            status: row.status,
          ));
    }
    return result;
  }

  /// Raw (unresolved) per-user nets recomputed from rows — the cache's truth.
  Future<Map<String, Map<String, int>>> _recomputeRawNets(String groupId) async {
    final nets = <String, Map<String, int>>{};
    void add(String currency, String userId, int delta) {
      final byCurrency = nets.putIfAbsent(currency, () => <String, int>{});
      byCurrency[userId] = (byCurrency[userId] ?? 0) + delta;
    }

    final expenseRows = await (db.select(db.expenses)
          ..where((e) => e.groupId.equals(groupId) & e.deletedAt.isNull()))
        .get();
    for (final row in expenseRows) {
      final shares = await _sharesOf(row.id);
      add(row.currency, row.paidBy, row.amountTotal);
      for (final entry in shares.entries) {
        add(row.currency, entry.key, -entry.value);
      }
    }
    final settlementRows = await (db.select(db.settlements)
          ..where((s) => s.groupId.equals(groupId)))
        .get();
    for (final row in settlementRows) {
      if (!engine.settlementBalanceApplied(row.status)) continue;
      add(row.currency, row.fromUser, row.amount);
      add(row.currency, row.toUser, -row.amount);
    }
    return nets;
  }

  bool _netsEqual(Map<String, Map<String, int>> a, Map<String, Map<String, int>> b) {
    final currencies = <String>{...a.keys, ...b.keys};
    for (final currency in currencies) {
      final mapA = a[currency] ?? const {};
      final mapB = b[currency] ?? const {};
      final userIds = <String>{...mapA.keys, ...mapB.keys};
      for (final id in userIds) {
        if ((mapA[id] ?? 0) != (mapB[id] ?? 0)) return false;
      }
    }
    return true;
  }
}
