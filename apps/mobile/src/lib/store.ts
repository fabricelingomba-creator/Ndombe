import * as SQLite from 'expo-sqlite';
import type { KeyValueStore } from './offline';

let db: Promise<SQLite.SQLiteDatabase> | null = null;

function open() {
  db ??= SQLite.openDatabaseAsync('elongo.db').then(async (d) => {
    await d.execAsync(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, saved_at INTEGER NOT NULL);`);
    return d;
  });
  return db;
}

/** Copies hors ligne et file d'attente, dans la base SQLite privée de l'app. */
export const store: KeyValueStore = {
  async get(key) {
    const row = await (await open()).getFirstAsync<{ value: string; saved_at: number }>(
      'SELECT value, saved_at FROM kv WHERE key = ?',
      [key],
    );
    return row ? { value: row.value, savedAt: row.saved_at } : null;
  },
  async set(key, value, savedAt) {
    await (await open()).runAsync(
      'INSERT INTO kv (key, value, saved_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, saved_at = excluded.saved_at',
      [key, value, savedAt],
    );
  },
  async delete(key) {
    await (await open()).runAsync('DELETE FROM kv WHERE key = ?', [key]);
  },
  async keys(prefix) {
    const rows = await (await open()).getAllAsync<{ key: string }>('SELECT key FROM kv WHERE key LIKE ? ORDER BY key', [
      `${prefix.replace(/[%_]/g, '')}%`,
    ]);
    return rows.map((r) => r.key);
  },
  async clear() {
    await (await open()).runAsync('DELETE FROM kv');
  },
};
