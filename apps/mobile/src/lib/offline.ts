/**
 * Mode hors ligne : chaque lecture de l'API est gardée sur le téléphone avec
 * sa date ; sans réseau, l'app affiche la dernière copie et le dit. Les
 * actions sans risque (marquer une notification lue) attendent le retour du
 * réseau dans une file ; un paiement, lui, exige toujours le réseau.
 */
export interface KeyValueStore {
  get(key: string): Promise<{ value: string; savedAt: number } | null>;
  set(key: string, value: string, savedAt: number): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
  clear(): Promise<void>;
}

export interface Cached<T> {
  data: T;
  /** Date de la copie (ms) ; null si la donnée vient d'arriver du réseau. */
  offlineSince: number | null;
}

export class OfflineError extends Error {
  constructor() {
    super('Hors ligne et aucune copie enregistrée sur ce téléphone.');
  }
}

/** Erreur réseau (pas de connexion, délai) par opposition à une réponse d'erreur de l'API. */
export function isNetworkFailure(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof Error && err.name === 'AbortError');
}

/** Lit depuis le réseau et garde une copie ; sans réseau, renvoie la copie. */
export async function readThrough<T>(
  store: KeyValueStore,
  key: string,
  fetcher: () => Promise<T>,
  now: () => number = Date.now,
): Promise<Cached<T>> {
  try {
    const data = await fetcher();
    await store.set(`cache:${key}`, JSON.stringify(data), now());
    return { data, offlineSince: null };
  } catch (err) {
    if (!isNetworkFailure(err)) throw err;
    const copy = await store.get(`cache:${key}`);
    if (!copy) throw new OfflineError();
    return { data: JSON.parse(copy.value) as T, offlineSince: copy.savedAt };
  }
}

export interface QueuedAction {
  /** Identifiant stable : rejouer deux fois la même action ne change rien. */
  id: string;
  method: 'POST' | 'PUT';
  path: string;
  body?: unknown;
}

const ALLOWED_OFFLINE = [/^\/v1\/me\/notifications\/[0-9a-f-]{36}\/read$/, /^\/v1\/me\/notifications\/read-all$/];

/** Seules des actions idempotentes et sans enjeu peuvent attendre le réseau. */
export function canQueue(action: QueuedAction): boolean {
  return action.method === 'POST' && ALLOWED_OFFLINE.some((re) => re.test(action.path));
}

export async function enqueue(store: KeyValueStore, action: QueuedAction, now: () => number = Date.now) {
  if (!canQueue(action)) throw new Error(`Action non autorisée hors ligne : ${action.path}`);
  await store.set(`outbox:${action.id}`, JSON.stringify(action), now());
}

/**
 * Rejoue la file dans l'ordre. Une action rejetée par l'API (4xx) est
 * abandonnée ; une panne réseau arrête le rejeu, qui reprendra plus tard.
 */
export async function flushOutbox(
  store: KeyValueStore,
  send: (action: QueuedAction) => Promise<{ ok: boolean; status: number }>,
): Promise<{ sent: number; dropped: number; pending: number }> {
  const keys = await store.keys('outbox:');
  const entries = (
    await Promise.all(keys.map(async (k) => ({ key: k, entry: await store.get(k) })))
  ).filter((e): e is { key: string; entry: { value: string; savedAt: number } } => e.entry !== null);
  entries.sort((a, b) => a.entry.savedAt - b.entry.savedAt);
  let sent = 0;
  let dropped = 0;
  for (const [i, { key, entry }] of entries.entries()) {
    let res: { ok: boolean; status: number };
    try {
      res = await send(JSON.parse(entry.value) as QueuedAction);
    } catch (err) {
      if (isNetworkFailure(err)) return { sent, dropped, pending: entries.length - i };
      throw err;
    }
    if (res.ok) sent++;
    else if (res.status >= 400 && res.status < 500) dropped++;
    else return { sent, dropped, pending: entries.length - i };
    await store.delete(key);
  }
  return { sent, dropped, pending: 0 };
}
