import { enqueue, flushOutbox, KeyValueStore, OfflineError, readThrough } from '../offline';

function memoryStore(): KeyValueStore & { data: Map<string, { value: string; savedAt: number }> } {
  const data = new Map<string, { value: string; savedAt: number }>();
  return {
    data,
    async get(k) {
      return data.get(k) ?? null;
    },
    async set(k, value, savedAt) {
      data.set(k, { value, savedAt });
    },
    async delete(k) {
      data.delete(k);
    },
    async keys(prefix) {
      return [...data.keys()].filter((k) => k.startsWith(prefix));
    },
    async clear() {
      data.clear();
    },
  };
}

const networkDown = () => Promise.reject(new TypeError('Network request failed'));
const ID = '0f8e4a52-6c1f-4f7e-9a39-2b3c4d5e6f70';

describe('Lecture hors ligne', () => {
  it('garde une copie et la ressert sans réseau, avec sa date', async () => {
    const store = memoryStore();
    expect(await readThrough(store, 'notes', async () => [1, 2], () => 1000)).toEqual({ data: [1, 2], offlineSince: null });
    expect(await readThrough(store, 'notes', networkDown)).toEqual({ data: [1, 2], offlineSince: 1000 });
  });

  it("dit clairement qu'il n'y a pas de copie, et laisse passer les erreurs de l'API", async () => {
    const store = memoryStore();
    await expect(readThrough(store, 'cours', networkDown)).rejects.toBeInstanceOf(OfflineError);
    const denied = Object.assign(new Error('Interdit'), { status: 403 });
    await expect(readThrough(store, 'cours', () => Promise.reject(denied))).rejects.toBe(denied);
  });
});

describe("File d'attente hors ligne", () => {
  it("n'accepte que des actions sans enjeu", async () => {
    const store = memoryStore();
    await enqueue(store, { id: 'a', method: 'POST', path: `/v1/me/notifications/${ID}/read` });
    await expect(
      enqueue(store, { id: 'b', method: 'POST', path: `/v1/me/invoices/${ID}/payments`, body: {} }),
    ).rejects.toThrow('non autorisée');
    expect(await store.keys('outbox:')).toEqual(['outbox:a']);
  });

  it('rejoue dans l’ordre, abandonne un refus, reprend plus tard après une panne', async () => {
    const store = memoryStore();
    let t = 0;
    for (const id of ['1', '2', '3']) await enqueue(store, { id, method: 'POST', path: '/v1/me/notifications/read-all' }, () => ++t);
    const seen: string[] = [];
    const first = await flushOutbox(store, async (a) => {
      seen.push(a.id);
      if (a.id === '1') return { ok: false, status: 404 };
      if (a.id === '2') throw new TypeError('Network request failed');
      return { ok: true, status: 200 };
    });
    expect(first).toEqual({ sent: 0, dropped: 1, pending: 2 });
    expect(seen).toEqual(['1', '2']);
    const second = await flushOutbox(store, async () => ({ ok: true, status: 200 }));
    expect(second).toEqual({ sent: 2, dropped: 0, pending: 0 });
    expect(await store.keys('outbox:')).toEqual([]);
  });
});
