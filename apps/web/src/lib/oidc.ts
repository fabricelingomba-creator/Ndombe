import 'server-only';
import { config } from './config';

export const PORTAL_CLIENT_ID = 'elongo-portal';

export function endpoints(issuer: string) {
  const base = `${issuer}/protocol/openid-connect`;
  return { authorize: `${base}/auth`, token: `${base}/token`, logout: `${base}/logout` };
}

/** URL utilisée par le serveur web pour joindre Keycloak (peut différer de l'URL publique). */
function internal(url: string, issuer: string): string {
  const internalBase = config.keycloakInternalUrl;
  if (!internalBase) return url;
  const publicBase = issuer.replace(/\/realms\/.*$/, '');
  return url.startsWith(publicBase) ? internalBase + url.slice(publicBase.length) : url;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_expires_in?: number;
}

async function tokenRequest(issuer: string, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(internal(endpoints(issuer).token, issuer), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: PORTAL_CLIENT_ID, ...params }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Keycloak a refusé l'échange de jeton (${res.status})`);
  return (await res.json()) as TokenResponse;
}

export function exchangeCode(issuer: string, code: string, verifier: string, redirectUri: string) {
  return tokenRequest(issuer, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri });
}

export function refresh(issuer: string, refreshToken: string) {
  return tokenRequest(issuer, { grant_type: 'refresh_token', refresh_token: refreshToken });
}
