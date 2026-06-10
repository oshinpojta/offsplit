import 'errors.dart';
import 'types.dart';

/// Follow the merged_into chain to the live survivor (§5.2, M4).
/// Every balance/membership/settlement read MUST resolve through this.
/// Throws on unknown users and asserts against cycles (the D1 tripwire).
String effectiveUserId(Map<String, UserRecord> users, String id) {
  final seen = <String>{};
  var current = id;
  while (true) {
    final user = users[current];
    if (user == null) throw EngineError(EngineError.unknownUser, 'unknown user: $current');
    if (user.status != 'merged') return current;
    if (seen.contains(current)) {
      throw EngineError(EngineError.mergeCycle, 'merge cycle at: $current');
    }
    seen.add(current);
    final next = user.mergedInto;
    if (next == null) {
      throw EngineError(EngineError.mergeCycle, 'merged user without merged_into: $current');
    }
    current = next;
  }
}
