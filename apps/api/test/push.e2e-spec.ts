import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DatabaseService } from '../src/db/database.service';
import { messages, NotificationMessage } from '../src/notifications/catalog';
import { NotificationDispatcher } from '../src/notifications/notification-dispatcher';
import { NotificationsService } from '../src/notifications/notifications.service';
import { LogPushTransport, PUSH_TRANSPORT } from '../src/notifications/push';
import { createHarness, Harness } from './harness';

/** Notifications push : téléphones enregistrés, envoi par la file, préférences, désinscription. */
describe('Notifications push', () => {
  let h: Harness;
  let dispatcher: NotificationDispatcher;
  let push: LogPushTransport;
  const tenants: Record<string, { id: string; realm: string; host: string }> = {};
  const tokens: Record<string, string> = {};
  const users: Record<string, string> = {};
  const phone = (n: number) => `ExponentPushToken[telephone-${n}-abcdef]`;

  const api = () => request(h.app.getHttpServer());
  const as = (who: string, t = 'a') => ({ Host: tenants[t].host, Authorization: `Bearer ${tokens[who]}` });
  const devices = async (t = 'a') =>
    (await h.admin.query<{ token: string; user_id: string }>('SELECT token, user_id FROM push_devices WHERE tenant_id = $1 ORDER BY token', [tenants[t].id]))
      .rows;
  const deliveries = async () =>
    (await h.admin.query<{ status: string; attempts: number }>(`SELECT status, attempts FROM notification_deliveries WHERE channel = 'push'`)).rows;

  async function addUser(key: string, t = 'a') {
    const email = `${key}@${t}.cd`;
    const user = await h.admin.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, full_name, external_id, status) VALUES ($1, $2, $3, $2, 'active') RETURNING id`,
      [tenants[t].id, email, `Nom ${key}`],
    );
    users[key] = user.rows[0].id;
    await h.admin.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type)
       SELECT $1, $2, id, 'university' FROM roles WHERE tenant_id = $1 AND key = 'student'`,
      [tenants[t].id, users[key]],
    );
    tokens[key] = await h.token(tenants[t].realm, { sub: email });
  }

  function notify(who: string, message: NotificationMessage = messages.paymentSucceeded(25000, 'USD', true), t = 'a') {
    const id = tenants[t].id;
    return h.app.get(DatabaseService).withTenant(id, (tx) => h.app.get(NotificationsService).notify(tx, id, [users[who]], message));
  }

  beforeAll(async () => {
    h = await createHarness();
    dispatcher = h.app.get(NotificationDispatcher);
    push = h.app.get(PUSH_TRANSPORT);
    const platformToken = await h.token('elongo-platform', { sub: 'ops', realm_access: { roles: ['platform-admin'] } });
    for (const [key, slug] of [['a', 'unipa'], ['b', 'unipb']]) {
      const res = await api()
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${platformToken}`)
        .send({ slug, name: `Université ${slug}`, rector: { email: `recteur@${slug}.cd`, fullName: 'Recteur' } })
        .expect(201);
      tenants[key] = { id: res.body.id, realm: res.body.keycloakRealm, host: `${slug}.elongo.test` };
    }
    await addUser('etu');
    await addUser('etu2');
    await addUser('etub', 'b');
  });

  afterAll(async () => {
    await h?.close();
  });

  it("refuse un jeton qui n'est pas un jeton Expo", async () => {
    await api().post('/v1/me/push-devices').set(as('etu')).send({ token: 'https://evil.example', platform: 'ios' }).expect(400);
    await api().post('/v1/me/push-devices').set(as('etu')).send({ token: phone(1), platform: 'windows' }).expect(400);
  });

  it('sans téléphone enregistré, rien ne part en push', async () => {
    await notify('etu');
    expect(await deliveries()).toEqual([]);
  });

  it('envoie sur le téléphone enregistré, avec le lien et sans autre donnée', async () => {
    await api().post('/v1/me/push-devices').set(as('etu')).send({ token: phone(1), platform: 'android' }).expect(204);
    await notify('etu');
    push.sent.length = 0;
    await dispatcher.runOnce({ scheduled: false });
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]).toMatchObject({
      to: [phone(1)],
      title: expect.stringContaining('Paiement reçu'),
      data: { link: expect.stringMatching(/^\/espace/), tenant: 'unipa', notificationId: expect.any(String) },
    });
    expect(Object.keys(push.sent[0].data).sort()).toEqual(['link', 'notificationId', 'tenant']);
    expect((await deliveries()).map((d) => d.status)).toEqual(['sent']);
  });

  it('un téléphone qui change de compte ne reçoit plus les notifications du précédent', async () => {
    await api().post('/v1/me/push-devices').set(as('etu2')).send({ token: phone(1), platform: 'android' }).expect(204);
    expect(await devices()).toEqual([{ token: phone(1), user_id: users.etu2 }]);
    await h.admin.query('DELETE FROM notification_deliveries');
    await notify('etu');
    expect(await deliveries()).toEqual([]);
  });

  it('chaque université a ses propres téléphones', async () => {
    await api().post('/v1/me/push-devices').set(as('etub', 'b')).send({ token: phone(1), platform: 'android' }).expect(204);
    expect(await devices('a')).toEqual([{ token: phone(1), user_id: users.etu2 }]);
    expect(await devices('b')).toEqual([{ token: phone(1), user_id: users.etub }]);
    // Un compte d'une autre université ne peut pas désinscrire le téléphone d'ici.
    await api().post('/v1/me/push-devices/unregister').set(as('etub', 'b')).send({ token: phone(1) }).expect(204);
    expect(await devices('a')).toHaveLength(1);
  });

  it('respecte le choix de couper le push pour une catégorie', async () => {
    await h.admin.query('DELETE FROM notification_deliveries');
    const prefs = await api()
      .put('/v1/me/notification-preferences')
      .set(as('etu2'))
      .send({ push: { finance: false } })
      .expect(200);
    expect(prefs.body.find((p: { category: string }) => p.category === 'finance')).toMatchObject({ email: true, push: false });
    await notify('etu2');
    expect(await deliveries()).toEqual([]);
    await notify('etu2', messages.announcement(randomUUID(), 'Rentrée', 'Lundi'));
    expect(await deliveries()).toHaveLength(1);
  });

  it('réessaie après une panne, et oublie un téléphone où l’app est désinstallée', async () => {
    const original = push.send.bind(push);
    push.send = async () => {
      throw new Error('Expo Push a répondu 503');
    };
    await dispatcher.runOnce({ scheduled: false });
    expect(await deliveries()).toEqual([{ status: 'pending', attempts: 1 }]);

    push.send = async (m) => m.to.map((token) => ({ token, ok: false, unregistered: true, error: 'DeviceNotRegistered' }));
    await h.admin.query(`UPDATE notification_deliveries SET next_attempt_at = now()`);
    await dispatcher.runOnce({ scheduled: false });
    push.send = original;
    expect((await deliveries())[0].status).toBe('failed');
    expect(await devices('a')).toEqual([]);
  });

  it('la déconnexion désinscrit le téléphone', async () => {
    await api().post('/v1/me/push-devices').set(as('etu')).send({ token: phone(2), platform: 'ios' }).expect(204);
    await api().post('/v1/me/push-devices/unregister').set(as('etu')).send({ token: phone(2) }).expect(204);
    expect(await devices('a')).toEqual([]);
  });
});
