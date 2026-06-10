/// Sprint 3 gate (code half): UPI link building — exact format, integer-only
/// rupee conversion, VPA validation, missing-VPA prompt path, persistence.
/// (The other half — GPay/PhonePe/Paytm opening the link pre-filled on real
/// hardware — is an operational check, tracked in ROADMAP Sprint 3.)
library;

import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:offsplit/data/db.dart';
import 'package:offsplit/data/ledger_repository.dart';
import 'package:offsplit/features/settle/settle_service.dart';
import 'package:offsplit/features/settle/upi_link.dart';

void main() {
  group('paiseToRupeesString (integer math only)', () {
    test('conversion edges', () {
      expect(paiseToRupeesString(1), '0.01');
      expect(paiseToRupeesString(10), '0.10');
      expect(paiseToRupeesString(100), '1.00');
      expect(paiseToRupeesString(12345), '123.45');
      expect(paiseToRupeesString(123456789), '1234567.89');
      expect(paiseToRupeesString(1000000000000), '10000000000.00');
    });

    test('rejects zero, negative, over-bound', () {
      expect(() => paiseToRupeesString(0), throwsA(isA<UpiError>()));
      expect(() => paiseToRupeesString(-5), throwsA(isA<UpiError>()));
      expect(() => paiseToRupeesString(1000000000001), throwsA(isA<UpiError>()));
    });
  });

  group('buildUpiPayLink', () {
    test('exact link format with encoding', () {
      final link = buildUpiPayLink(
        payeeVpa: 'priya@okhdfc',
        payeeName: 'Priya S',
        amountPaise: 12345,
        note: 'Flat 4B settle',
      );
      expect(link,
          'upi://pay?pa=priya%40okhdfc&pn=Priya%20S&am=123.45&cu=INR&tn=Flat%204B%20settle');
    });

    test('omits tn when note empty; special chars encoded', () {
      expect(
        buildUpiPayLink(payeeVpa: 'a.b-c_1@upi', payeeName: 'R&D #1', amountPaise: 100),
        'upi://pay?pa=a.b-c_1%40upi&pn=R%26D%20%231&am=1.00&cu=INR',
      );
    });

    test('long notes are clipped to 80 chars', () {
      final link = buildUpiPayLink(
        payeeVpa: 'x@upi',
        payeeName: 'X',
        amountPaise: 100,
        note: 'n' * 200,
      );
      final tn = Uri.parse(link).queryParameters['tn']!;
      expect(tn.length, 80);
    });

    test('VPA validation fails closed', () {
      for (final bad in ['', 'no-at-sign', '@upi', 'a@', 'a@1numbers', 'sp ace@upi']) {
        expect(
          () => buildUpiPayLink(payeeVpa: bad, payeeName: 'X', amountPaise: 100),
          throwsA(isA<UpiError>()),
          reason: 'should reject "$bad"',
        );
      }
    });
  });

  group('SettleService', () {
    late AppDatabase db;
    late LedgerRepository repo;
    late SettleService settle;
    var idCounter = 0;

    setUp(() {
      db = AppDatabase(NativeDatabase.memory());
      idCounter = 0;
      repo = LedgerRepository(db,
          idGenerator: () => 'id-${(++idCounter).toString().padLeft(3, '0')}',
          clock: () => 5000 + idCounter);
      settle = SettleService(db);
    });

    tearDown(() => db.close());

    test('missing payee VPA throws missing_vpa (UI prompt path), then succeeds after setUserVpa',
        () async {
      final alice = await repo.createUser(displayName: 'Alice');
      final group = await repo.createGroup(name: 'Goa Trip', createdBy: alice.id);
      final bob = await repo.createGhost(groupId: group.id, displayName: 'Bob');
      final s = await repo.createSettlement(
          groupId: group.id, fromUser: bob.id, toUser: alice.id, amount: 25050);

      await expectLater(
        settle.buildLinkForSettlement(s.id),
        throwsA(predicate((e) => e is UpiError && e.code == UpiError.missingVpa)),
      );

      await settle.setUserVpa(alice.id, 'alice@okaxis');
      final link = await settle.buildLinkForSettlement(s.id);
      expect(link,
          'upi://pay?pa=alice%40okaxis&pn=Alice&am=250.50&cu=INR&tn=Goa%20Trip%20settle');

      // persisted on the settlement row
      final row = await (db.select(db.settlements)..where((t) => t.id.equals(s.id)))
          .getSingle();
      expect(row.upiLink, link);
    });

    test('explicit VPA override wins without touching the profile', () async {
      final alice = await repo.createUser(displayName: 'Alice', upiId: 'alice@okaxis');
      final group = await repo.createGroup(name: 'Rent', createdBy: alice.id);
      final bob = await repo.createGhost(groupId: group.id, displayName: 'Bob');
      final s = await repo.createSettlement(
          groupId: group.id, fromUser: bob.id, toUser: alice.id, amount: 100);
      final link = await settle.buildLinkForSettlement(s.id, payeeVpa: 'alice@paytm');
      expect(link.contains('pa=alice%40paytm'), isTrue);
    });

    test('setUserVpa validates shape', () async {
      final alice = await repo.createUser(displayName: 'Alice');
      expect(() => settle.setUserVpa(alice.id, 'nope'), throwsA(isA<UpiError>()));
    });
  });
}
