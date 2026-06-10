/** Error codes shared verbatim with the Dart engine and the golden vectors. */
export type EngineErrorCode =
  | 'invalid_amount'
  | 'amount_out_of_bounds'
  | 'no_participants'
  | 'too_many_participants'
  | 'duplicate_participant'
  | 'split_sum_mismatch'
  | 'negative_share'
  | 'percent_sum_mismatch'
  | 'invalid_percent'
  | 'invalid_weight'
  | 'unknown_user'
  | 'merge_cycle'
  | 'not_merged'
  | 'illegal_transition';

export class EngineError extends Error {
  constructor(
    readonly code: EngineErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'EngineError';
  }
}
