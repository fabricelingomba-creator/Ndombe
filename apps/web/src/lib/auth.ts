import 'server-only';
import { redirect } from 'next/navigation';
import { ApiError, getMe } from './api';
import { readAccess, readRefreshToken } from './session';

/**
 * Utilisateur connecté d'une page protégée. Sans jeton d'accès valide :
 * rafraîchissement si possible, sinon page de connexion.
 */
export async function requireUser(host: string, returnTo: string) {
  const session = await readAccess(host);
  if (!session) {
    const target = encodeURIComponent(returnTo);
    if (await readRefreshToken(host)) redirect(`/auth/refresh?returnTo=${target}`);
    redirect(`/connexion?returnTo=${target}`);
  }
  try {
    return { me: await getMe(host, session.accessToken), accessToken: session.accessToken };
  } catch (err) {
    // 401 : jeton révoqué ; 403 : compte absent de l'annuaire ou désactivé.
    if (err instanceof ApiError && err.status === 401) redirect(`/connexion?returnTo=${encodeURIComponent(returnTo)}`);
    if (err instanceof ApiError && err.status === 403) redirect('/connexion?erreur=compte');
    throw err;
  }
}
