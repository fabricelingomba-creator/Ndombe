import { NextResponse, type NextRequest } from 'next/server';
import { getManifest } from '@/lib/api';
import { endpoints, PORTAL_CLIENT_ID } from '@/lib/oidc';
import { codeChallenge, randomToken } from '@/lib/pkce';
import { portalRequest } from '@/lib/request';
import { safeReturnTo } from '@/lib/return-to';
import { saveLoginFlow } from '@/lib/session';

/** Démarre la connexion OIDC (code + PKCE) auprès du realm Keycloak de l'université. */
export async function GET(req: NextRequest) {
  const { host, origin } = await portalRequest();
  const manifest = await getManifest(host);
  if (!manifest) return new NextResponse('Université introuvable', { status: 404 });

  const state = randomToken();
  const verifier = randomToken(48);
  const returnTo = safeReturnTo(req.nextUrl.searchParams.get('returnTo'));
  await saveLoginFlow({ host, state, verifier, returnTo }, origin.startsWith('https:'));

  const url = new URL(endpoints(manifest.auth.issuer).authorize);
  url.search = new URLSearchParams({
    client_id: PORTAL_CLIENT_ID,
    response_type: 'code',
    scope: 'openid email profile',
    redirect_uri: `${origin}/auth/callback`,
    state,
    code_challenge: await codeChallenge(verifier),
    code_challenge_method: 'S256',
    ui_locales: manifest.locale,
  }).toString();
  return NextResponse.redirect(url);
}
