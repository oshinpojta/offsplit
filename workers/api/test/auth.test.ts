/**
 * Sprint 4 gate: Firebase ID-token verification at the edge (§12) + session
 * upsert + profile. Tokens are real RS256 JWTs verified through the
 * production code path (JWKS injected via AUTH_JWKS_JSON).
 */
import { SignJWT, generateKeyPair } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, PROJECT_ID, signUp, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});

describe('auth/session', () => {
  it('creates a user on first sign-in and is idempotent on repeat', async () => {
    const token = await ctx.token('google-sub-1', { name: 'Asha', email: 'a@x.in' });
    const first = await ctx.request('POST', '/auth/session', { token });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { user: { id: string; display_name: string } };
    expect(firstBody.user.display_name).toBe('Asha');

    const second = await ctx.request('POST', '/auth/session', { token });
    const secondBody = (await second.json()) as { user: { id: string } };
    expect(secondBody.user.id).toBe(firstBody.user.id); // upsert, not duplicate
  });

  it('rejects missing/garbage/wrong-audience tokens', async () => {
    expect((await ctx.request('GET', '/me')).status).toBe(401);
    expect((await ctx.request('GET', '/me', { token: 'garbage' })).status).toBe(401);

    // properly signed but wrong audience — must fail
    const { privateKey } = await generateKeyPair('RS256');
    const wrongAud = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setSubject('s')
      .setIssuer(`https://securetoken.google.com/${PROJECT_ID}`)
      .setAudience('some-other-project')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
    expect((await ctx.request('GET', '/me', { token: wrongAud })).status).toBe(401);
  });

  it('rejects expired tokens signed with the real key', async () => {
    const expired = await ctx.expiredToken('google-sub-2');
    expect((await ctx.request('POST', '/auth/session', { token: expired })).status).toBe(401);
  });

  it('requires /auth/session before other routes (session_required)', async () => {
    const token = await ctx.token('google-sub-3');
    const response = await ctx.request('GET', '/me', { token });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe('session_required');
  });
});

describe('/me', () => {
  it('returns and updates the profile; VPA shape enforced', async () => {
    const { token } = await signUp(ctx, 'google-sub-4', 'Asha');

    const me = await ctx.request('GET', '/me', { token });
    expect(me.status).toBe(200);

    const good = await ctx.request('PATCH', '/me', {
      token,
      body: { display_name: 'Asha K', default_upi_id: 'asha@okhdfc' },
    });
    expect(good.status).toBe(200);
    const updated = (await good.json()) as {
      user: { display_name: string; default_upi_id: string };
    };
    expect(updated.user.display_name).toBe('Asha K');
    expect(updated.user.default_upi_id).toBe('asha@okhdfc');

    const bad = await ctx.request('PATCH', '/me', {
      token,
      body: { default_upi_id: 'not a vpa' },
    });
    expect(bad.status).toBe(400);
  });
});

describe('claim landing (D3: GET never mutates)', () => {
  it('is readable without auth and changes nothing', async () => {
    const response = await ctx.request('GET', '/claim/some-token-value');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { claim_token: string };
    expect(body.claim_token).toBe('some-token-value');
  });
});
