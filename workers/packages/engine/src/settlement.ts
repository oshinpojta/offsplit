import { EngineError } from './errors.js';
import type { SettlementAction, SettlementStatus } from './types.js';

/**
 * Settlement state machine (§8.2). Transitions are guarded, never LWW (S5):
 * a stale offline transition that is illegal from the current state is
 * rejected, not applied.
 *
 *   pending ──mark_paid──► marked_paid ──confirm──► confirmed (terminal)
 *                               │
 *                            dispute
 *                               ▼
 *                           disputed ──reset──► pending
 */
const TRANSITIONS: Record<SettlementStatus, Partial<Record<SettlementAction, SettlementStatus>>> = {
  pending: { mark_paid: 'marked_paid' },
  marked_paid: { confirm: 'confirmed', dispute: 'disputed' },
  disputed: { reset: 'pending' },
  confirmed: {},
};

export function applySettlementTransition(
  from: SettlementStatus,
  action: SettlementAction,
): SettlementStatus {
  const next = TRANSITIONS[from]?.[action];
  if (!next) throw new EngineError('illegal_transition', `${from} + ${action}`);
  return next;
}

/** M10: settlements affect balances at marked_paid and confirmed only. */
export function settlementBalanceApplied(status: SettlementStatus): boolean {
  return status === 'marked_paid' || status === 'confirmed';
}
