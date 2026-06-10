/**
 * Firebase ID token verification at the edge (§12). Tokens are RS256 JWTs
 * signed by Google's securetoken service; we verify against its JWK set
 * (cached per isolate). `AUTH_JWKS_JSON` overrides the key source for tests
 * and key pinning.
 */
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { unauthorized } from './errors.js';
import type { Env } from './d1.js';

const GOOGLE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

let remoteJwks: JWTVerifyGetKey | undefined;
const localJwksCache = new Map<string, JWTVerifyGetKey>();

function keySource(env: Env): JWTVerifyGetKey {
  if (env.AUTH_JWKS_JSON) {
    let cached = localJwksCache.get(env.AUTH_JWKS_JSON);
    if (!cached) {
      cached = createLocalJWKSet(JSON.parse(env.AUTH_JWKS_JSON));
      localJwksCache.set(env.AUTH_JWKS_JSON, cached);
    }
    return cached;
  }
  remoteJwks ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return remoteJwks;
}

export interface VerifiedIdentity {
  sub: string;
  email: string | null;
  name: string | null;
}

export async function verifyFirebaseIdToken(
  token: string,
  env: Env,
): Promise<VerifiedIdentity> {
  try {
    const { payload } = await jwtVerify(token, keySource(env), {
      issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
      audience: env.FIREBASE_PROJECT_ID,
      algorithms: ['RS256'],
    });
    if (!payload.sub) throw unauthorized();
    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : null,
      name: typeof payload.name === 'string' ? payload.name : null,
    };
  } catch {
    throw unauthorized();
  }
}

export function bearerToken(authorizationHeader: string | undefined): string {
  if (!authorizationHeader?.startsWith('Bearer ')) throw unauthorized();
  return authorizationHeader.slice('Bearer '.length);
}
