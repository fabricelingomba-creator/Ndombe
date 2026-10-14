import { ExpoPushTransport, pushBody } from './push';

describe('ExpoPushTransport', () => {
  const message = { to: ['ExponentPushToken[aaaaaaaaaa]', 'ExponentPushToken[bbbbbbbbbb]'], title: 'Titre', body: 'Corps', data: { link: '/espace' } };

  it('envoie un message par téléphone et lit les tickets dans l’ordre', async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ status: 'ok', id: 't1' }, { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }] }),
        { status: 200 },
      ),
    );
    const tickets = await new ExpoPushTransport('jeton-expo-0123', fetchFn).send(message);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://exp.host/--/api/v2/push/send');
    expect(init.headers.authorization).toBe('Bearer jeton-expo-0123');
    expect(JSON.parse(init.body)).toEqual([
      expect.objectContaining({ to: message.to[0], title: 'Titre', body: 'Corps', data: { link: '/espace' }, channelId: 'default' }),
      expect.objectContaining({ to: message.to[1] }),
    ]);
    expect(tickets).toEqual([
      { token: message.to[0], ok: true, unregistered: false },
      { token: message.to[1], ok: false, unregistered: true, error: 'gone' },
    ]);
  });

  it('lève une erreur sur une réponse HTTP en échec, pour réessayer', async () => {
    const fetchFn = jest.fn().mockResolvedValue(new Response('busy', { status: 503 }));
    await expect(new ExpoPushTransport(undefined, fetchFn).send(message)).rejects.toThrow('503');
    expect(fetchFn.mock.calls[0][1].headers.authorization).toBeUndefined();
  });

  it('raccourcit le texte affiché sur l’écran verrouillé', () => {
    expect(pushBody('court')).toBe('court');
    expect(pushBody('x'.repeat(500))).toHaveLength(178);
  });
});
