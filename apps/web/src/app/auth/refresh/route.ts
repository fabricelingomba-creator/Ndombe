import { NextResponse, type NextRequest } from 'next/server';
import { getManifest } from '@/lib/api';
import { refresh } from '@/lib/oidc';
import { portalRequest } from '@/lib/request';
import { safeReturnTo } from '@/lib/return-to';
import { clearSession, readRefreshToken, saveSession } from '@/lib/session';

/** Renouvelle le jeton d'accès expiré (15 min) sans redemander le mot de passe. */
export async function GET(req: NextRequest) {
  const { host, origin } = await portalRequest();
  const returnTo = safeReturnTo(req.nextUrl.searchParams.get('returnTo'));
  const refreshToken = await readRefreshToken(host);
  const manifest = await getManifest(host);
  if (refreshToken && manifest) {
    try {
      await saveSession(host, origin.startsWith('https:'), await refresh(manifest.auth.issuer, refreshToken));
      return NextResponse.redirect(new URL(returnTo, origin));
    } catch {
      // Jeton de rafraîchissement expiré ou révoqué : nouvelle connexion.
    }
  }
  await clearSession();
  return NextResponse.redirect(new URL(`/connexion?returnTo=${encodeURIComponent(returnTo)}`, origin));
}
