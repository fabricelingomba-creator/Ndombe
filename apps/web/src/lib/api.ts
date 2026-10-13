import 'server-only';
import { cache } from 'react';
import { config } from './config';
import type {
  Announcement,
  GradeSheet,
  Homepage,
  Manifest,
  Me,
  MyCourse,
  ReviewItem,
  TeachingOffering,
  TermGrades,
} from './types';

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
export const getMyCourses = (host: string, token: string) => apiFetch<MyCourse[]>(host, '/v1/me/courses', token);
export const getMyGrades = (host: string, token: string) => apiFetch<TermGrades[]>(host, '/v1/me/grades', token);
export const getTeaching = (host: string, token: string) => apiFetch<TeachingOffering[]>(host, '/v1/me/teaching', token);
export const getReviewQueue = (host: string, token: string, status: 'submitted' | 'approved') =>
  apiFetch<ReviewItem[]>(host, `/v1/grade-sheets?status=${status}`, token);

/** Feuille de notes ; null si l'offre n'existe pas ou n'est pas dans la portée de l'utilisateur. */
export async function getGradeSheet(host: string, token: string, offeringId: string): Promise<GradeSheet | null> {
  try {
    return await apiFetch<GradeSheet>(host, `/v1/offerings/${encodeURIComponent(offeringId)}`, token);
  } catch (err) {
    if (err instanceof ApiError && [400, 403, 404].includes(err.status)) return null;
    throw err;
  }
}

export type SendResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

/** Écriture vers l'API ; renvoie le message d'erreur de l'API au lieu de lever une exception. */
export async function apiSend<T>(
  host: string,
  path: string,
  token: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
): Promise<SendResult<T>> {
  const res = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: {
      'x-elongo-host': host,
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // Réponse vide (204) ou non JSON.
  }
  if (res.ok) return { ok: true, data: json as T };
  const message = Array.isArray(json?.message) ? json.message.join(', ') : json?.message;
  return { ok: false, status: res.status, message: typeof message === 'string' ? message : `Erreur ${res.status}` };
}
