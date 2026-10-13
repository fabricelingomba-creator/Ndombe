import 'server-only';
import { headers } from 'next/headers';

/** Domaine et origine du portail tels que vus par le navigateur (derrière un proxy éventuel). */
export async function portalRequest() {
  const h = await headers();
  const host = (h.get('x-forwarded-host') ?? h.get('host') ?? '').split(',')[0].trim().toLowerCase();
  const proto = (h.get('x-forwarded-proto') ?? 'http').split(',')[0].trim();
  return { host, origin: `${proto}://${host}` };
}
