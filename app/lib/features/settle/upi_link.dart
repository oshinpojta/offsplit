/// UPI intent link builder (§8.1). The ONLY place paise become rupees —
/// everywhere else in the app money is integer paise (M7). Generic
/// `upi://pay` intent so the OS app-chooser appears (GPay/PhonePe/Paytm);
/// never the deprecated collect flow (§2.2).
library;

const int _maxAmountPaise = 1000000000000; // mirrors engine D2 bound
const int _maxNoteLength = 80; // PSP apps truncate long notes; keep ours short

/// Permissive VPA shape: handle@psp. Mirrored in workers/api (vpa.ts).
final RegExp vpaPattern = RegExp(r'^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}@[a-zA-Z]{2,64}$');

class UpiError implements Exception {
  const UpiError(this.code, [this.detail]);
  final String code;
  final String? detail;

  static const missingVpa = 'missing_vpa';
  static const invalidVpa = 'invalid_vpa';
  static const invalidAmount = 'invalid_amount';

  @override
  String toString() => 'UpiError($code${detail == null ? '' : ': $detail'})';
}

/// Integer-only paise → "rupees.with-2dp" string. No doubles, ever.
String paiseToRupeesString(int paise) {
  if (paise <= 0 || paise > _maxAmountPaise) {
    throw const UpiError(UpiError.invalidAmount);
  }
  final rupees = paise ~/ 100;
  final remainder = paise % 100;
  return '$rupees.${remainder.toString().padLeft(2, '0')}';
}

/// Build `upi://pay?pa=&pn=&am=&cu=INR&tn=`.
/// `am` is editable in some PSP apps — acceptable for a trust-based friends
/// app, not enforceable (§8.1).
String buildUpiPayLink({
  required String payeeVpa,
  required String payeeName,
  required int amountPaise,
  String? note,
}) {
  if (payeeVpa.isEmpty) throw const UpiError(UpiError.missingVpa);
  if (!vpaPattern.hasMatch(payeeVpa)) {
    throw UpiError(UpiError.invalidVpa, payeeVpa);
  }
  final amount = paiseToRupeesString(amountPaise);
  final trimmedNote = (note ?? '').trim();
  final clippedNote = trimmedNote.length > _maxNoteLength
      ? trimmedNote.substring(0, _maxNoteLength)
      : trimmedNote;

  final buffer = StringBuffer('upi://pay')
    ..write('?pa=${Uri.encodeComponent(payeeVpa)}')
    ..write('&pn=${Uri.encodeComponent(payeeName)}')
    ..write('&am=$amount')
    ..write('&cu=INR');
  if (clippedNote.isNotEmpty) {
    buffer.write('&tn=${Uri.encodeComponent(clippedNote)}');
  }
  return buffer.toString();
}
