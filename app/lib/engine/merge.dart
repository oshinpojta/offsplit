import 'errors.dart';
import 'identity.dart';
import 'types.dart';

/// Merge planning (§6, M1–M3). Pure: returns what should change; the sync
/// layer applies it. A merge mutates ONLY the merged user's row (A0/M2).
class MergePlan {
  const MergePlan.noop(this.survivorId)
      : kind = 'noop',
        mergedId = null;
  const MergePlan.merge(this.survivorId, String this.mergedId) : kind = 'merge';

  final String kind; // 'noop' | 'merge'
  final String survivorId;
  final String? mergedId;
}

/// Resolution-first (M3): resolve both ids to live survivors, then decide.
MergePlan planMerge(Map<String, UserRecord> users, String primaryId, String mergedId) {
  final survivorId = effectiveUserId(users, primaryId);
  final target = effectiveUserId(users, mergedId);
  if (survivorId == target) return MergePlan.noop(survivorId);
  return MergePlan.merge(survivorId, target);
}

void applyMergePlan(Map<String, UserRecord> users, MergePlan plan) {
  if (plan.kind == 'noop') return;
  final merged = users[plan.mergedId];
  if (merged == null) throw EngineError(EngineError.unknownUser, plan.mergedId);
  users[plan.mergedId!] =
      merged.copyWith(status: 'merged', mergedInto: () => plan.survivorId);
  // D1 tripwire: resolving the merged user must terminate at the survivor.
  final resolved = effectiveUserId(users, plan.mergedId!);
  if (resolved != plan.survivorId) {
    throw EngineError(EngineError.mergeCycle, 'post-merge resolution mismatch: $resolved');
  }
}

/// Reversal (R5/T3): restore the merged user — trivially exact because the
/// merge wrote exactly one row (A0).
void applyReverse(Map<String, UserRecord> users, String mergedId) {
  final user = users[mergedId];
  if (user == null) throw EngineError(EngineError.unknownUser, mergedId);
  if (user.status != 'merged') throw EngineError(EngineError.notMerged, mergedId);
  users[mergedId] = user.copyWith(status: 'active', mergedInto: () => null);
}
