import 'server-only';
import { cookies } from 'next/headers';
import { config } from './config';
import { seal, unseal } from './seal';

/**
 * Session web : jeton d'accès et jeton de rafraîchissement Keycloak, chacun
 * dans son cookie chiffré, httpOnly, limité au domaine du portail.
 * Le domaine est inscrit dans le contenu chiffré : un cookie copié vers une
 * autre université est rejeté.
 */
const ACCESS = 'elongo_at';
const REFRESH = 'elongo_rt';
const FLOW = 'elongo_oidc';

export interface AccessSession {
  host: string;
  accessToken: string;
  /** Expiration du jeton d'accès, en secondes depuis l'époque Unix. */
  exp: number;
}

export interface LoginFlow {
  host: string;
  state: string;
  verifier: string;
  returnTo: string;
}

function cookieOptions(secure: boolean, maxAge: number) {
  return { httpOnly: true, secure, sameSite: 'lax' as const, path: '/', maxAge };
}

export async function saveSession(
  host: string,
  secure: boolean,
  tokens: { access_token: string; expires_in: number; refresh_token?: string; refresh_expires_in?: number },
) {
  const jar = await cookies();
  const exp = Math.floor(Date.now() / 1000) + tokens.expires_in;
  jar.set(ACCESS, await seal({ host, accessToken: tokens.access_token, exp }, config.sessionSecret, tokens.expires_in), cookieOptions(secure, tokens.expires_in));
  if (tokens.refresh_token) {
    const ttl = tokens.refresh_expires_in && tokens.refresh_expires_in > 0 ? tokens.refresh_expires_in : 30 * 60;
    jar.set(REFRESH, await seal({ host, refreshToken: tokens.refresh_token }, config.sessionSecret, ttl), cookieOptions(secure, ttl));
  }
}

export async function readAccess(host: string): Promise<AccessSession | null> {
  const s = await unseal<AccessSession & Record<string, unknown>>((await cookies()).get(ACCESS)?.value, config.sessionSecret);
  if (!s || s.host !== host || s.exp <= Math.floor(Date.now() / 1000) + 10) return null;
  return s;
}

export async function readRefreshToken(host: string): Promise<string | null> {
  const s = await unseal<{ host: string; refreshToken: string }>((await cookies()).get(REFRESH)?.value, config.sessionSecret);
  return s && s.host === host ? s.refreshToken : null;
}

export async function clearSession() {
  const jar = await cookies();
  jar.delete(ACCESS);
  jar.delete(REFRESH);
}

export async function saveLoginFlow(flow: LoginFlow, secure: boolean) {
  (await cookies()).set(FLOW, await seal({ ...flow }, config.sessionSecret, 600), cookieOptions(secure, 600));
}

export async function takeLoginFlow(host: string): Promise<LoginFlow | null> {
  const jar = await cookies();
  const flow = await unseal<LoginFlow & Record<string, unknown>>(jar.get(FLOW)?.value, config.sessionSecret);
  jar.delete(FLOW);
  return flow && flow.host === host ? flow : null;
}
