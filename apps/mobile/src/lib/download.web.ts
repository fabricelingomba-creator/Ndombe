import type { ApiClient } from './api';

/** Navigateur : le PDF est récupéré avec le jeton puis proposé au téléchargement. */
export async function downloadAndShare(api: ApiClient, path: string, filename: string): Promise<void> {
  let res = await fetch(api.url(path), { headers: { ...(await api.authHeaders()), accept: 'application/pdf' } });
  if (res.status === 401) res = await fetch(api.url(path), { headers: { ...(await api.authHeaders(true)), accept: 'application/pdf' } });
  if (!res.ok) throw new Error(`Téléchargement impossible (erreur ${res.status}).`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
