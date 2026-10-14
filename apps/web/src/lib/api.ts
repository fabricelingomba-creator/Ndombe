import 'server-only';
import { cache } from 'react';
import { config } from './config';
import type {
  Announcement,
  FeeStructure,
  GradeSheet,
  Homepage,
  Manifest,
  Me,
  MyCourse,
  MyInvoice,
  PaymentOption,
  PaymentProviderConfig,
  ReviewItem,
  StudentInvoice,
  TeachingOffering,
  TermGrades,
  Transcript,
  TranscriptRequest,
  TranscriptVerification,
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

export const getMyTranscripts = (host: string, token: string) => apiFetch<Transcript[]>(host, '/v1/me/transcripts', token);
export const getTranscriptQueue = (host: string, token: string, status: 'requested' | 'validated') =>
  apiFetch<TranscriptRequest[]>(host, `/v1/transcripts?status=${status}`, token);

export const getMyInvoices = (host: string, token: string) => apiFetch<MyInvoice[]>(host, '/v1/me/invoices', token);
export const getPaymentOptions = (host: string, token: string) =>
  apiFetch<PaymentOption[]>(host, '/v1/me/payment-options', token);
export const getFeeStructures = (host: string, token: string) =>
  apiFetch<FeeStructure[]>(host, '/v1/fee-structures', token);
export const getInvoices = (host: string, token: string, status?: 'open' | 'paid') =>
  apiFetch<StudentInvoice[]>(host, `/v1/invoices${status ? `?status=${status}` : ''}`, token);
export const getPaymentProviders = (host: string, token: string) =>
  apiFetch<PaymentProviderConfig[]>(host, '/v1/payment-providers', token);

/** Vérification publique d'un code imprimé sur un relevé ; null si inconnu. */
export async function verifyTranscript(host: string, code: string): Promise<TranscriptVerification | null> {
  try {
    return await apiFetch<TranscriptVerification>(host, `/v1/public/transcripts/verify/${encodeURIComponent(code)}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Relaie tel quel un webhook de prestataire de paiement : corps brut (la
 * signature porte sur l'octet près) et en-têtes de signature.
 */
export async function relayPaymentWebhook(path: string, rawBody: ArrayBuffer, headers: Record<string, string>) {
  return fetch(`${config.apiUrl}${path}`, { method: 'POST', headers, body: rawBody, cache: 'no-store' });
}

/** Fichier binaire (PDF) de l'API, relayé tel quel au navigateur. */
export async function apiDownload(host: string, path: string, token: string): Promise<Response> {
  return fetch(`${config.apiUrl}${path}`, {
    headers: { 'x-elongo-host': host, authorization: `Bearer ${token}`, accept: 'application/pdf' },
    cache: 'no-store',
  });
}

export type SendResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

/** Écriture vers l'API ; renvoie le message d'erreur de l'API au lieu de lever une exception. */
export async function apiSend<T>(
  host: string,
  path: string,
  token: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<SendResult<T>> {
  const res = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: {
      ...extraHeaders,
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
