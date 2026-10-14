import { shouldLock, singleFlight } from '../single-flight';

describe('Renouvellement du jeton', () => {
  it('les appels simultanés partagent un seul renouvellement', async () => {
    let calls = 0;
    let release!: (v: string) => void;
    const refresh = singleFlight(() => {
      calls++;
      return new Promise<string>((r) => (release = r));
    });
    const a = refresh();
    const b = refresh();
    release('jeton');
    expect(await Promise.all([a, b])).toEqual(['jeton', 'jeton']);
    expect(calls).toBe(1);
    // Une fois terminé, un nouvel appel relance bien un renouvellement.
    const c = refresh();
    release('autre');
    expect(await c).toBe('autre');
    expect(calls).toBe(2);
  });

  it('un échec libère le verrou', async () => {
    let n = 0;
    const flaky = singleFlight(async () => {
      if (n++ === 0) throw new Error('réseau');
      return 'ok';
    });
    await expect(flaky()).rejects.toThrow('réseau');
    expect(await flaky()).toBe('ok');
  });
});

describe('Verrouillage', () => {
  it("redemande l'identité après 5 minutes en arrière-plan", () => {
    expect(shouldLock(null, 1_000_000, 300_000)).toBe(false);
    expect(shouldLock(1_000_000, 1_299_999, 300_000)).toBe(false);
    expect(shouldLock(1_000_000, 1_300_000, 300_000)).toBe(true);
  });
});
