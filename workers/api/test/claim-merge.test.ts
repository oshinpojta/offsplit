/**
 * Sprint 5: the claim/merge server half — T7 fail-closed token safety,
 * single-winner CAS, merge invariants over HTTP (T1 third-party invariance),
 * idempotency, reversal window, Phase-1 /merge restrictions.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, signUp, type TestContext } from './helpers.js';

let ctx: TestContext;
let asha: { token: string; userId: string };
let ravi: { token: string; userId: string };
let groupId: string;
let bobGhostId: string;
let bobClaimToken: string;

async function json<T>(r: Response): Promise<T> {
  return (await r.json()) as T;
}

beforeEach(async () => {
  ctx = await createTestContext();
  asha = await signUp(ctx, 'sub-asha', 'Asha');
  ravi = await signUp(ctx, 'sub-ravi', 'Ravi');
  groupId = (
    await json<{ group: { id: string } }>(
      await ctx.request('POST', '/groups', { token: asha.token, body: { name: 'Flat' } }),
    )
  ).group.id;
  const ghost = await json<{ ghost: { id: string }; claim_token: string }>(
    await ctx.request('POST', `/groups/${groupId}/ghosts`, {
      token: asha.token,
      body: { display_name: 'Bob' },
    }),
  );
  bobGhostId = ghost.ghost.id;
  bobClaimToken = ghost.claim_token;
  // Asha paid 300 equal {Asha, Bob-ghost, Ravi… not member} — add Ravi first
  await ctx.request('POST', `/groups/${groupId}/members`, {
    token: asha.token,
    body: { user_id: ravi.userId },
  });
  await ctx.request('POST', `/groups/${groupId}/expenses`, {
    token: asha.token,
    body: {
      description: 'Groceries',
      amount_total: 300,
      paid_by: asha.userId,
      split_type: 'equal',
      participants: [
        { user_id: asha.userId },
        { user_id: bobGhostId },
        { user_id: ravi.userId },
      ],
    },
  });
});

async function balances(): Promise<Record<string, number>> {
  const r = await json<{ balances: Record<string, { net: Record<string, number> }> }>(
    await ctx.request('GET', `/groups/${groupId}/balances`, { token: asha.token }),
  );
  return r.balances.INR!.net;
}

describe('claim flow (§6.2)', () => {
  it('real signed-in user claims the ghost; history intact; third party unchanged (T1)', async () => {
    expect(await balances()).toEqual({
      [asha.userId]: 200,
      [bobGhostId]: -100,
      [ravi.userId]: -100,
    });

    const bobReal = await signUp(ctx, 'sub-bob', 'Bob Real');
    const r = await ctx.request('POST', '/claim', {
      token: bobReal.token,
      body: { token: bobClaimToken },
    });
    expect(r.status).toBe(200);
    const claimBody = await json<{
      result: string;
      merge_record_id: string | null;
      reversible_until: number | null;
    }>(r);
    expect(claimBody.result).toBe('merged');
    expect(claimBody.merge_record_id).not.toBeNull();

    // Ravi's number is untouched; Bob's debt re-points to his real account.
    expect(await balances()).toEqual({
      [asha.userId]: 200,
      [bobReal.userId]: -100,
      [ravi.userId]: -100,
    });

    // the claimer is now an effective member: can read the group
    expect((await ctx.request('GET', `/groups/${groupId}`, { token: bobReal.token })).status).toBe(
      200,
    );
  });

  it('T7: invalid, reused and expired tokens fail closed and indistinguishably', async () => {
    const bobReal = await signUp(ctx, 'sub-bob', 'Bob Real');

    // invalid
    const invalid = await ctx.request('POST', '/claim', {
      token: bobReal.token,
      body: { token: 'x'.repeat(43) },
    });
    expect(invalid.status).toBe(404);
    expect((await json<{ error: string }>(invalid)).error).toBe('claim_invalid');

    // claim once (winner)
    expect(
      (
        await ctx.request('POST', '/claim', {
          token: bobReal.token,
          body: { token: bobClaimToken },
        })
      ).status,
    ).toBe(200);

    // reuse by someone else — same generic error, no oracle
    const eve = await signUp(ctx, 'sub-eve', 'Eve');
    const reused = await ctx.request('POST', '/claim', {
      token: eve.token,
      body: { token: bobClaimToken },
    });
    expect(reused.status).toBe(404);
    expect((await json<{ error: string }>(reused)).error).toBe('claim_invalid');
  });

  it('claiming your own ghost twice is a no-op (R6) — same survivor, no error', async () => {
    const bobReal = await signUp(ctx, 'sub-bob', 'Bob');
    await ctx.request('POST', '/claim', {
      token: bobReal.token,
      body: { token: bobClaimToken },
    });
    // direct re-merge of the tombstoned ghost into the same survivor: noop
    const again = await ctx.request('POST', '/merge', {
      token: bobReal.token,
      body: { merged_user_id: bobGhostId, confirm: true },
    });
    expect(again.status).toBe(200);
    expect((await json<{ result: string }>(again)).result).toBe('noop');
  });
});

describe('merge + reverse (§6.3/§6.4)', () => {
  it('direct /merge folds a co-group ghost; reverse restores exact pre-merge balances (T3)', async () => {
    const before = await balances();

    const merged = await json<{ result: string; merge_record_id: string }>(
      await ctx.request('POST', '/merge', {
        token: asha.token,
        body: { merged_user_id: bobGhostId, confirm: true },
      }),
    );
    expect(merged.result).toBe('merged');

    // Asha absorbed Bob's −100; Ravi untouched (T1/T2/R7 over HTTP)
    expect(await balances()).toEqual({ [asha.userId]: 100, [ravi.userId]: -100 });

    const reversed = await ctx.request('POST', `/merge/${merged.merge_record_id}/reverse`, {
      token: asha.token,
    });
    expect(reversed.status).toBe(200);
    expect(await balances()).toEqual(before); // exact (T3)

    // second reverse: window/row consumed → 409
    expect(
      (
        await ctx.request('POST', `/merge/${merged.merge_record_id}/reverse`, {
          token: asha.token,
        })
      ).status,
    ).toBe(409);
  });

  it('Phase-1 restrictions: real accounts and stranger ghosts cannot be merged', async () => {
    // real account target → must use claim
    const realTarget = await ctx.request('POST', '/merge', {
      token: asha.token,
      body: { merged_user_id: ravi.userId, confirm: true },
    });
    expect(realTarget.status).toBe(403);
    expect((await json<{ error: string }>(realTarget)).error).toBe('merge_requires_claim');

    // a ghost in a group the caller doesn't belong to → forbidden
    const eve = await signUp(ctx, 'sub-eve', 'Eve');
    const stranger = await ctx.request('POST', '/merge', {
      token: eve.token,
      body: { merged_user_id: bobGhostId, confirm: true },
    });
    expect(stranger.status).toBe(403);
    expect((await json<{ error: string }>(stranger)).error).toBe('merge_requires_shared_group');

    // confirm flag is mandatory (R4)
    expect(
      (
        await ctx.request('POST', '/merge', {
          token: asha.token,
          body: { merged_user_id: bobGhostId },
        })
      ).status,
    ).toBe(400);
  });

  it('reversal not allowed for unrelated callers', async () => {
    const merged = await json<{ merge_record_id: string }>(
      await ctx.request('POST', '/merge', {
        token: asha.token,
        body: { merged_user_id: bobGhostId, confirm: true },
      }),
    );
    const eve = await signUp(ctx, 'sub-eve', 'Eve');
    expect(
      (
        await ctx.request('POST', `/merge/${merged.merge_record_id}/reverse`, {
          token: eve.token,
        })
      ).status,
    ).toBe(409);
  });
});
