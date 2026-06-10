/**
 * Sprint 5: settlement routes — upi_link generation (§8.1/§11), role-gated
 * guarded transitions (S5), stale-transition CAS, M10 balance effects.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, signUp, type TestContext } from './helpers.js';

let ctx: TestContext;
let asha: { token: string; userId: string };
let ravi: { token: string; userId: string };
let groupId: string;

async function json<T>(r: Response): Promise<T> {
  return (await r.json()) as T;
}

beforeEach(async () => {
  ctx = await createTestContext();
  asha = await signUp(ctx, 'sub-asha', 'Asha');
  ravi = await signUp(ctx, 'sub-ravi', 'Ravi');
  groupId = (
    await json<{ group: { id: string } }>(
      await ctx.request('POST', '/groups', { token: asha.token, body: { name: 'Goa' } }),
    )
  ).group.id;
  await ctx.request('POST', `/groups/${groupId}/members`, {
    token: asha.token,
    body: { user_id: ravi.userId },
  });
  // Ravi owes Asha 100
  await ctx.request('POST', `/groups/${groupId}/expenses`, {
    token: asha.token,
    body: {
      description: 'Dinner',
      amount_total: 100,
      paid_by: asha.userId,
      split_type: 'exact',
      participants: [{ user_id: ravi.userId, amount: 100 }],
    },
  });
});

async function createSettlement(): Promise<{ id: string; upi_link: string | null }> {
  const r = await ctx.request('POST', `/groups/${groupId}/settlements`, {
    token: ravi.token,
    body: { from_user: ravi.userId, to_user: asha.userId, amount: 100 },
  });
  expect(r.status).toBe(201);
  return (await json<{ settlement: { id: string; upi_link: string | null } }>(r)).settlement;
}

describe('settlement creation', () => {
  it('includes a upi_link when the payee has a VPA; null otherwise', async () => {
    const before = await createSettlement();
    expect(before.upi_link).toBeNull();

    await ctx.request('PATCH', '/me', {
      token: asha.token,
      body: { default_upi_id: 'asha@okhdfc' },
    });
    const after = await createSettlement();
    expect(after.upi_link).toBe(
      'upi://pay?pa=asha%40okhdfc&pn=Asha&am=1.00&cu=INR&tn=Goa%20settle',
    );
  });

  it('rejects self-settlement and non-member parties', async () => {
    expect(
      (
        await ctx.request('POST', `/groups/${groupId}/settlements`, {
          token: ravi.token,
          body: { from_user: ravi.userId, to_user: ravi.userId, amount: 50 },
        })
      ).status,
    ).toBe(400);
  });
});

describe('transitions (S5 + M10)', () => {
  it('full happy path with role gates: payer marks, payee confirms', async () => {
    const settlement = await createSettlement();

    // payee cannot mark-paid
    expect(
      (
        await ctx.request('POST', `/settlements/${settlement.id}/mark-paid`, {
          token: asha.token,
        })
      ).status,
    ).toBe(403);
    // payer cannot confirm
    expect(
      (await ctx.request('POST', `/settlements/${settlement.id}/mark-paid`, { token: ravi.token }))
        .status,
    ).toBe(200);
    expect(
      (await ctx.request('POST', `/settlements/${settlement.id}/confirm`, { token: ravi.token }))
        .status,
    ).toBe(403);

    // M10: marked_paid already nets the group to zero
    const mid = await json<{ balances: Record<string, { net: Record<string, number> }> }>(
      await ctx.request('GET', `/groups/${groupId}/balances`, { token: asha.token }),
    );
    expect(mid.balances.INR!.net).toEqual({ [asha.userId]: 0, [ravi.userId]: 0 });

    expect(
      (await ctx.request('POST', `/settlements/${settlement.id}/confirm`, { token: asha.token }))
        .status,
    ).toBe(200);
  });

  it('dispute reverts the balance effect; reset re-opens; illegal transitions 409', async () => {
    const settlement = await createSettlement();
    await ctx.request('POST', `/settlements/${settlement.id}/mark-paid`, { token: ravi.token });
    expect(
      (await ctx.request('POST', `/settlements/${settlement.id}/dispute`, { token: asha.token }))
        .status,
    ).toBe(200);

    const reverted = await json<{ balances: Record<string, { net: Record<string, number> }> }>(
      await ctx.request('GET', `/groups/${groupId}/balances`, { token: asha.token }),
    );
    expect(reverted.balances.INR!.net).toEqual({ [asha.userId]: 100, [ravi.userId]: -100 });

    // confirm-before-marked rejects (illegal_transition → 409)
    expect(
      (await ctx.request('POST', `/settlements/${settlement.id}/confirm`, { token: asha.token }))
        .status,
    ).toBe(409);

    // disputed → reset (payer) → pending → mark-paid again
    expect(
      (await ctx.request('POST', `/settlements/${settlement.id}/reset`, { token: ravi.token }))
        .status,
    ).toBe(200);
    expect(
      (await ctx.request('POST', `/settlements/${settlement.id}/mark-paid`, { token: ravi.token }))
        .status,
    ).toBe(200);

    // terminal: after confirm, everything rejects
    await ctx.request('POST', `/settlements/${settlement.id}/confirm`, { token: asha.token });
    for (const action of ['mark-paid', 'confirm', 'dispute', 'reset'] as const) {
      const r = await ctx.request('POST', `/settlements/${settlement.id}/${action}`, {
        token: action === 'mark-paid' || action === 'reset' ? ravi.token : asha.token,
      });
      expect(r.status, `confirmed + ${action}`).toBe(409);
    }
  });
});
