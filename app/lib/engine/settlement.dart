import 'errors.dart';

/// Settlement state machine (§8.2). Transitions are guarded, never LWW (S5).
///
///   pending ──mark_paid──► marked_paid ──confirm──► confirmed (terminal)
///                               │
///                            dispute
///                               ▼
///                           disputed ──reset──► pending
const Map<String, Map<String, String>> _transitions = {
  'pending': {'mark_paid': 'marked_paid'},
  'marked_paid': {'confirm': 'confirmed', 'dispute': 'disputed'},
  'disputed': {'reset': 'pending'},
  'confirmed': {},
};

String applySettlementTransition(String from, String action) {
  final next = _transitions[from]?[action];
  if (next == null) {
    throw EngineError(EngineError.illegalTransition, '$from + $action');
  }
  return next;
}

/// M10: settlements affect balances at marked_paid and confirmed only.
bool settlementBalanceApplied(String status) =>
    status == 'marked_paid' || status == 'confirmed';
