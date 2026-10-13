import 'server-only';
import { cache } from 'react';
import { config } from './config';
import type { Announcement, Homepage, Manifest, Me } from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Appel serveur à serveur vers l'API. Le domaine du portail est transmis dans
 * x-elongo-host : c'est lui qui désigne l'université.
 */
async function apiFetch<T>(host: string, path: string, token?: string): Promise<T> {
  const res = await fetch(`${config.apiUrl}${path}`, {
    headers: {
      'x-elongo-host': host,
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) throw new ApiError(res.status, `${path} : ${res.status}`);
  return (await res.json()) as T;
}

/** Manifeste de l'université, mis en commun pour tous les composants d'une même requête. */
export const getManifest = cache(async (host: string): Promise<Manifest | null> => {
  try {
    return await apiFetch<Manifest>(host, '/v1/tenant/manifest');
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) return null;
    throw err;
  }
});

export const getHomepage = (host: string) => apiFetch<Homepage>(host, '/v1/public/homepage');
export const getMe = (host: string, token: string) => apiFetch<Me>(host, '/v1/me', token);
export const getAnnouncements = (host: string, token: string) =>
  apiFetch<Announcement[]>(host, '/v1/announcements?limit=10', token);
