/// Settlement → UPI link wiring (§8). The money path is device-only: this
/// service builds the deep link and persists it on the settlement row for
/// the UI to launch; nothing here talks to a server (§4).
library;

import 'package:drift/drift.dart';

import '../../data/db.dart';
import '../../data/ledger_repository.dart';
import 'upi_link.dart';

class SettleService {
  SettleService(this.db);

  final AppDatabase db;

  /// Build (and persist) the UPI link for a settlement. The payee's
  /// `default_upi_id` is the target VPA; an explicit [payeeVpa] overrides it
  /// (the "payee just told me their VPA" prompt path — §8.1). Throws
  /// [UpiError.missingVpa] when neither exists so the UI can prompt the
  /// payee to add one.
  Future<String> buildLinkForSettlement(String settlementId, {String? payeeVpa}) async {
    final settlement = await (db.select(db.settlements)
          ..where((s) => s.id.equals(settlementId)))
        .getSingleOrNull();
    if (settlement == null) {
      throw const LedgerException(LedgerException.notFound, 'settlement');
    }
    final payee = await (db.select(db.users)
          ..where((u) => u.id.equals(settlement.toUser)))
        .getSingle();
    final group = await (db.select(db.groups)
          ..where((g) => g.id.equals(settlement.groupId)))
        .getSingle();

    final vpa = payeeVpa ?? payee.defaultUpiId;
    if (vpa == null || vpa.isEmpty) {
      throw const UpiError(UpiError.missingVpa);
    }

    final link = buildUpiPayLink(
      payeeVpa: vpa,
      payeeName: payee.displayName,
      amountPaise: settlement.amount,
      note: '${group.name} settle',
    );

    await (db.update(db.settlements)..where((s) => s.id.equals(settlementId)))
        .write(SettlementsCompanion(upiLink: Value(link)));
    return link;
  }

  /// Save a payee-provided VPA onto their profile (the prompt path outcome).
  Future<void> setUserVpa(String userId, String vpa) async {
    if (!vpaPattern.hasMatch(vpa)) throw UpiError(UpiError.invalidVpa, vpa);
    final updated = await (db.update(db.users)..where((u) => u.id.equals(userId)))
        .write(UsersCompanion(defaultUpiId: Value(vpa)));
    if (updated == 0) {
      throw const LedgerException(LedgerException.notFound, 'user');
    }
  }
}
