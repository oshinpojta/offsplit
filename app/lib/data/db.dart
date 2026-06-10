/// Local drift schema — the offline working source of truth (§10.1).
/// Mirrors the synced subset of BUILD_SPEC §5.1. All ids are client-generated
/// UUID strings (offline creation); all money is integer paise (M7); all
/// timestamps are epoch milliseconds.
///
/// `MemberBalances` is the materialized balance cache (§7.2): DERIVED state,
/// keyed by RAW user id — merges never touch it; identity resolves at read
/// time (M4), so the cache is merge-agnostic and rebuildable at any moment
/// from the immutable rows (D5).
library;

import 'package:drift/drift.dart';

part 'db.g.dart';

class Users extends Table {
  TextColumn get id => text()();
  TextColumn get displayName => text()();
  TextColumn get defaultUpiId => text().nullable()();
  BoolColumn get isGhost => boolean().withDefault(const Constant(false))();
  TextColumn get status => text().withDefault(const Constant('active'))();
  TextColumn get mergedInto => text().nullable()();
  IntColumn get createdAt => integer()();
  IntColumn get updatedAt => integer()();

  @override
  Set<Column> get primaryKey => {id};
}

class Groups extends Table {
  TextColumn get id => text()();
  TextColumn get name => text()();
  TextColumn get type => text().withDefault(const Constant('standard'))();
  TextColumn get defaultCurrency => text().withDefault(const Constant('INR'))();
  TextColumn get createdBy => text().references(Users, #id)();
  IntColumn get createdAt => integer()();
  IntColumn get updatedAt => integer()();
  IntColumn get deletedAt => integer().nullable()();

  @override
  Set<Column> get primaryKey => {id};
}

class GroupMembers extends Table {
  TextColumn get groupId => text().references(Groups, #id)();
  TextColumn get userId => text().references(Users, #id)();
  TextColumn get role => text().withDefault(const Constant('member'))();
  IntColumn get joinedAt => integer()();

  @override
  Set<Column> get primaryKey => {groupId, userId};
}

class Expenses extends Table {
  TextColumn get id => text()();
  TextColumn get groupId => text().references(Groups, #id)();
  TextColumn get description => text()();
  IntColumn get amountTotal => integer().check(amountTotal.isBiggerThanValue(0))();
  TextColumn get currency => text().withDefault(const Constant('INR'))();
  TextColumn get paidBy => text().references(Users, #id)();
  TextColumn get splitType => text()();
  IntColumn get txnDate => integer()();
  TextColumn get createdBy => text().references(Users, #id)();
  IntColumn get createdAt => integer()();
  IntColumn get updatedAt => integer()();
  IntColumn get deletedAt => integer().nullable()();

  @override
  Set<Column> get primaryKey => {id};
}

class ExpenseSplits extends Table {
  TextColumn get expenseId => text().references(Expenses, #id)();
  TextColumn get userId => text().references(Users, #id)();
  IntColumn get shareAmount =>
      integer().check(shareAmount.isBiggerOrEqualValue(0))();

  @override
  Set<Column> get primaryKey => {expenseId, userId};
}

class Settlements extends Table {
  TextColumn get id => text()();
  TextColumn get groupId => text().references(Groups, #id)();
  TextColumn get fromUser => text().references(Users, #id)();
  TextColumn get toUser => text().references(Users, #id)();
  IntColumn get amount => integer().check(amount.isBiggerThanValue(0))();
  TextColumn get currency => text().withDefault(const Constant('INR'))();
  TextColumn get method => text().withDefault(const Constant('upi'))();
  TextColumn get status => text().withDefault(const Constant('pending'))();
  TextColumn get upiLink => text().nullable()();
  TextColumn get markedPaidBy => text().nullable()();
  IntColumn get markedPaidAt => integer().nullable()();
  TextColumn get confirmedBy => text().nullable()();
  IntColumn get confirmedAt => integer().nullable()();
  IntColumn get createdAt => integer()();
  IntColumn get updatedAt => integer()();

  @override
  Set<Column> get primaryKey => {id};
}

/// Materialized per-group balance cache (§7.2). Raw user ids, per currency.
class MemberBalances extends Table {
  TextColumn get groupId => text().references(Groups, #id)();
  TextColumn get currency => text()();
  TextColumn get userId => text().references(Users, #id)();
  IntColumn get netAmount => integer()();

  @override
  Set<Column> get primaryKey => {groupId, currency, userId};
}

@DriftDatabase(
  tables: [Users, Groups, GroupMembers, Expenses, ExpenseSplits, Settlements, MemberBalances],
)
class AppDatabase extends _$AppDatabase {
  AppDatabase(super.e);

  @override
  int get schemaVersion => 1;
}
