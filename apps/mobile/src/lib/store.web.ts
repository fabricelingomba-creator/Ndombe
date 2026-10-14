import type { KeyValueStore } from './offline';

/** Version web (aperçu) : localStorage, le stockage SQLite web étant encore expérimental. */
const PREFIX = 'elongo.kv.';

export const store: KeyValueStore = {
  async get(key) {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as { value: string; savedAt: number }) : null;
  },
  async set(key, value, savedAt) {
    localStorage.setItem(PREFIX + key, JSON.stringify({ value, savedAt }));
  },
  async delete(key) {
    localStorage.removeItem(PREFIX + key);
  },
  async keys(prefix) {
    return Object.keys(localStorage)
      .filter((k) => k.startsWith(PREFIX + prefix))
      .map((k) => k.slice(PREFIX.length))
      .sort();
  },
  async clear() {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
  },
};
