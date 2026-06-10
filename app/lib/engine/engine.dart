/// Offsplit ledger engine — money math, balances, debt simplification,
/// settlement state machine, merge planning. Pure functions; no I/O.
/// Mirror of the TS engine (workers/packages/engine); both run the golden
/// vectors in engine-vectors/ (decision X1 in ENGINE_AND_SYNC_DESIGN.md).
library;

export 'balances.dart';
export 'errors.dart';
export 'identity.dart';
export 'merge.dart';
export 'settlement.dart';
export 'simplify.dart';
export 'splits.dart';
export 'types.dart';
