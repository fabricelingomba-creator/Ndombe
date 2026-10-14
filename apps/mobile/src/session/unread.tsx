import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useSession } from './session';

interface UnreadValue {
  count: number;
  refresh(): Promise<void>;
  set(count: number): void;
}

const UnreadContext = createContext<UnreadValue>({ count: 0, refresh: async () => undefined, set: () => undefined });

const POLL_MS = 60_000;

/** Pastille de l'onglet Notifications : relue au retour dans l'app et chaque minute. */
export function UnreadProvider({ children }: { children: React.ReactNode }) {
  const { api, online } = useSession();
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!api || !online) return;
    try {
      setCount((await api.get<{ count: number }>('/v1/me/notifications/unread-count')).count);
    } catch {
      // Sans réseau, on garde la dernière valeur.
    }
  }, [api, online]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    const sub = AppState.addEventListener('change', (s) => s === 'active' && void refresh());
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [refresh]);

  return <UnreadContext.Provider value={{ count, refresh, set: setCount }}>{children}</UnreadContext.Provider>;
}

export const useUnread = () => useContext(UnreadContext);
