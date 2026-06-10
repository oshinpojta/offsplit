import { EngineError } from './errors.js';
import type { UserRecord } from './types.js';

/**
 * Follow the merged_into chain to the live survivor (§5.2, M4).
 * Every balance/membership/settlement read MUST resolve through this.
 * Throws on unknown users and asserts against cycles (which M3 + D1
 * serialization make impossible to *create*; this is the tripwire).
 */
export function effectiveUserId(users: ReadonlyMap<string, UserRecord>, id: string): string {
  const seen = new Set<string>();
  let current = id;
  for (;;) {
    const user = users.get(current);
    if (!user) throw new EngineError('unknown_user', `unknown user: ${current}`);
    if (user.status !== 'merged') return current;
    if (seen.has(current)) throw new EngineError('merge_cycle', `merge cycle at: ${current}`);
    seen.add(current);
    if (user.mergedInto === null) {
      throw new EngineError('merge_cycle', `merged user without merged_into: ${current}`);
    }
    current = user.mergedInto;
  }
}
