/// Error codes shared verbatim with the TS engine and the golden vectors.
class EngineError implements Exception {
  const EngineError(this.code, [this.detail]);

  final String code;
  final String? detail;

  static const invalidAmount = 'invalid_amount';
  static const amountOutOfBounds = 'amount_out_of_bounds';
  static const noParticipants = 'no_participants';
  static const tooManyParticipants = 'too_many_participants';
  static const duplicateParticipant = 'duplicate_participant';
  static const splitSumMismatch = 'split_sum_mismatch';
  static const negativeShare = 'negative_share';
  static const percentSumMismatch = 'percent_sum_mismatch';
  static const invalidPercent = 'invalid_percent';
  static const invalidWeight = 'invalid_weight';
  static const unknownUser = 'unknown_user';
  static const mergeCycle = 'merge_cycle';
  static const notMerged = 'not_merged';
  static const illegalTransition = 'illegal_transition';

  @override
  String toString() => 'EngineError($code${detail == null ? '' : ': $detail'})';
}
