import { ApiClient, ApiError } from '../api';

function response(status: number, body: unknown) {
  return { ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) } as Response;
}

describe("Client de l'API", () => {
  it("désigne l'université et envoie le jeton", async () => {
    const fetch = jest.fn(async () => response(200, { ok: true }));
    const api = new ApiClient({
      baseUrl: 'https://api.elongo.app/',
      tenant: { slug: 'unikin' },
      accessToken: () => 'jeton',
      refresh: async () => null,
      fetch,
    });
    await api.get('/v1/me');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.elongo.app/v1/me');
    expect(init.headers).toMatchObject({ 'x-elongo-tenant': 'unikin', authorization: 'Bearer jeton' });
  });

  it('renouvelle une fois le jeton expiré puis rejoue la requête', async () => {
    const fetch = jest.fn().mockResolvedValueOnce(response(401, {})).mockResolvedValueOnce(response(200, [1]));
    const refresh = jest.fn(async () => 'neuf');
    const api = new ApiClient({ baseUrl: 'https://x', tenant: { slug: 'u1' }, accessToken: () => 'vieux', refresh, fetch });
    expect(await api.get('/v1/me/grades')).toEqual([1]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[1][1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer neuf' });
  });

  it("renvoie le message de l'API, ou un message clair", async () => {
    const make = (status: number, body: unknown) =>
      new ApiClient({
        baseUrl: 'https://x',
        tenant: { host: 'portail.unikin.cd' },
        accessToken: () => 't',
        refresh: async () => null,
        fetch: async () => response(status, body),
      });
    await expect(make(409, { message: 'Facture déjà réglée' }).post('/p')).rejects.toEqual(new ApiError(409, 'Facture déjà réglée'));
    await expect(make(413, undefined).post('/p')).rejects.toThrow('5 Mo');
    await expect(make(401, {}).get('/p')).rejects.toThrow('Session expirée');
    await expect(make(502, undefined).get('/p')).rejects.toThrow('indisponible');
  });
});
