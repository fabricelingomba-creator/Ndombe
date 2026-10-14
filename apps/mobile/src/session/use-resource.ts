import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { readThrough } from '@/lib/offline';
import { store } from '@/lib/store';
import { useSession } from './session';

export interface Resource<T> {
  data: T | null;
  /** Date de la copie affichée quand le réseau manque, sinon null. */
  offlineSince: number | null;
  error: string | null;
  loading: boolean;
  reload(): Promise<void>;
}

/** Lecture d'une ressource de l'API, avec copie hors ligne propre au compte. */
export function useResource<T>(name: string, path: string | null): Resource<T> {
  const { api, cacheKey } = useSession();
  const [state, setState] = useState<Omit<Resource<T>, 'reload'>>({ data: null, offlineSince: null, error: null, loading: true });

  const load = useCallback(async () => {
    if (!api || !path) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const r = await readThrough(store, cacheKey(name), () => api.get<T>(path));
      setState({ data: r.data, offlineSince: r.offlineSince, error: null, loading: false });
    } catch (err) {
      const message = err instanceof ApiError || err instanceof Error ? err.message : 'Erreur inconnue';
      setState((s) => ({ ...s, error: message, loading: false }));
    }
  }, [api, path, name, cacheKey]);

  useEffect(() => {
    void load();
  }, [load]);

  return { ...state, reload: load };
}
