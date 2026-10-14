/**
 * Les notifications portent un lien du portail web (/espace/…). L'app ouvre
 * l'écran équivalent quand il existe ; sinon (tâches du personnel) le lien
 * s'ouvre sur le portail web de l'université.
 */
export type LinkTarget = { kind: 'app'; href: '/' | '/notifications' | '/paiements' | '/etudes' } | { kind: 'web'; url: string } | null;

const APP_ROUTES: Record<string, '/' | '/notifications' | '/paiements' | '/etudes'> = {
  '/espace': '/',
  '/espace/notifications': '/notifications',
  '/espace/paiements': '/paiements',
  '/espace/notes': '/etudes',
  '/espace/cours': '/etudes',
};

export function linkTarget(link: string | null, portalUrl: string): LinkTarget {
  // Lien interne uniquement : jamais d'URL absolue ni de « // » venant de l'API.
  if (!link || !/^\/espace(\/[A-Za-z0-9/_-]*)?$/.test(link)) return null;
  const path = link.replace(/\/$/, '') || '/espace';
  const app = APP_ROUTES[path];
  if (app) return { kind: 'app', href: app };
  if (!/^https:\/\/[a-z0-9.-]+$/.test(portalUrl)) return null;
  return { kind: 'web', url: `${portalUrl}${path}` };
}
