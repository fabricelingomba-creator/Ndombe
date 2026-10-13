import { NextResponse, type NextRequest } from 'next/server';
import { getManifest } from '@/lib/api';
import { exchangeCode } from '@/lib/oidc';
import { portalRequest } from '@/lib/request';
import { saveSession, takeLoginFlow } from '@/lib/session';

/** Retour de Keycloak : vérifie l'état, échange le code, ouvre la session. */
export async function GET(req: NextRequest) {
  const { host, origin } = await portalRequest();
  const params = req.nextUrl.searchParams;
  const flow = await takeLoginFlow(host);
  const fail = (reason: string) => NextResponse.redirect(new URL(`/connexion?erreur=${reason}`, origin));

  if (!flow || params.get('state') !== flow.state) return fail('session');
  const code = params.get('code');
  if (params.get('error') || !code) return fail('refus');

  const manifest = await getManifest(host);
  if (!manifest) return fail('universite');
  try {
    const tokens = await exchangeCode(manifest.auth.issuer, code, flow.verifier, `${origin}/auth/callback`);
    await saveSession(host, origin.startsWith('https:'), tokens);
  } catch {
    return fail('jeton');
  }
  return NextResponse.redirect(new URL(flow.returnTo, origin));
}
