import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, JWTPayload, jwtVerify, JWTVerifyGetKey } from 'jose';
import { ENV, Env } from '../config/env';

/**
 * Fournit la clé de vérification d'un realm Keycloak. Remplaçable dans les
 * tests par une paire de clés locale.
 */
export const JWT_KEY_RESOLVER = Symbol('JWT_KEY_RESOLVER');
export type JwtKeyResolver = (issuer: string) => JWTVerifyGetKey;

export function remoteJwksResolver(): JwtKeyResolver {
  const cache = new Map<string, JWTVerifyGetKey>();
  return (issuer) => {
    let jwks = cache.get(issuer);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`));
      cache.set(issuer, jwks);
    }
    return jwks;
  };
}

@Injectable()
export class JwtVerifierService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(JWT_KEY_RESOLVER) private readonly keys: JwtKeyResolver,
  ) {}

  issuerFor(realm: string): string {
    return `${this.env.KEYCLOAK_URL.replace(/\/$/, '')}/realms/${realm}`;
  }

  /** Vérifie signature, émetteur (le realm attendu) et expiration. */
  async verify(token: string, realm: string): Promise<JWTPayload> {
    const issuer = this.issuerFor(realm);
    const { payload } = await jwtVerify(token, this.keys(issuer), {
      issuer,
      algorithms: ['RS256', 'ES256'],
      clockTolerance: 5,
    });
    return payload;
  }
}

export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return match ? match[1].trim() : null;
}
