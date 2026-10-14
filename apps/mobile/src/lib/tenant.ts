/**
 * Ce que l'utilisateur saisit pour trouver son université : le code court
 * (« unikin »), l'adresse du portail (« unikin.elongo.app ») ou un domaine
 * personnalisé (« portail.unikin.cd », éventuellement avec https://).
 */
export type TenantQuery = { kind: 'slug'; slug: string } | { kind: 'host'; host: string };

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;
const HOST = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function parseTenantInput(raw: string): TenantQuery | null {
  let text = raw.trim().toLowerCase();
  if (!text) return null;
  text = text.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
  if (SLUG.test(text)) return { kind: 'slug', slug: text };
  if (HOST.test(text)) return { kind: 'host', host: text };
  return null;
}
