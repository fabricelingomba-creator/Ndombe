import { NextResponse } from 'next/server';
import { getManifest } from '@/lib/api';
import { endpoints, PORTAL_CLIENT_ID } from '@/lib/oidc';
import { portalRequest } from '@/lib/request';
import { clearSession } from '@/lib/session';

/** Déconnexion : efface la session du portail puis celle de Keycloak. POST uniquement. */
export async function POST() {
  const { host, origin } = await portalRequest();
  await clearSession();
  const manifest = await getManifest(host);
  if (!manifest) return NextResponse.redirect(new URL('/', origin), 303);
  const url = new URL(endpoints(manifest.auth.issuer).logout);
  url.search = new URLSearchParams({ client_id: PORTAL_CLIENT_ID, post_logout_redirect_uri: `${origin}/` }).toString();
  return NextResponse.redirect(url, 303);
}
