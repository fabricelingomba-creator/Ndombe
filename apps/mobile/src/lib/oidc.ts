import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { CLIENT_ID, NATIVE_REDIRECT_URI } from './config';

WebBrowser.maybeCompleteAuthSession();

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  /** Expiration du jeton d'accès (ms). */
  expiresAt: number;
}

const discoveries = new Map<string, Promise<AuthSession.DiscoveryDocument>>();

function discovery(issuer: string) {
  let d = discoveries.get(issuer);
  if (!d) {
    d = AuthSession.fetchDiscoveryAsync(issuer);
    d.catch(() => discoveries.delete(issuer));
    discoveries.set(issuer, d);
  }
  return d;
}

export function redirectUri() {
  return AuthSession.makeRedirectUri({ native: NATIVE_REDIRECT_URI, path: 'auth/callback' });
}

function toTokens(r: AuthSession.TokenResponse, previousRefresh: string | null = null): Tokens {
  return {
    accessToken: r.accessToken,
    refreshToken: r.refreshToken ?? previousRefresh,
    expiresAt: (r.issuedAt + (r.expiresIn ?? 300)) * 1000,
  };
}

/**
 * Connexion par le SSO de l'université : la page Keycloak de son realm
 * s'ouvre dans le navigateur du système (mot de passe et double facteur ne
 * passent jamais par l'app), code d'autorisation + PKCE.
 */
export async function signIn(issuer: string): Promise<Tokens | null> {
  const doc = await discovery(issuer);
  const redirect = redirectUri();
  const request = new AuthSession.AuthRequest({
    clientId: CLIENT_ID,
    redirectUri: redirect,
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    usePKCE: true,
  });
  const result = await request.promptAsync(doc);
  if (result.type !== 'success') return null;
  const tokens = await AuthSession.exchangeCodeAsync(
    {
      clientId: CLIENT_ID,
      redirectUri: redirect,
      code: result.params.code,
      extraParams: { code_verifier: request.codeVerifier! },
    },
    doc,
  );
  return toTokens(tokens);
}

export async function refresh(issuer: string, refreshToken: string): Promise<Tokens> {
  const tokens = await AuthSession.refreshAsync({ clientId: CLIENT_ID, refreshToken }, await discovery(issuer));
  return toTokens(tokens, refreshToken);
}

export async function revoke(issuer: string, refreshToken: string): Promise<void> {
  const doc = await discovery(issuer).catch(() => null);
  if (!doc?.revocationEndpoint) return;
  await AuthSession.revokeAsync({ token: refreshToken, tokenTypeHint: AuthSession.TokenTypeHint.RefreshToken, clientId: CLIENT_ID }, doc).catch(
    () => undefined,
  );
}
