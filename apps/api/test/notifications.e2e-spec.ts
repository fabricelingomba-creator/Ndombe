import request from 'supertest';
import { EMAIL_TRANSPORT, LogEmailTransport } from '../src/notifications/email';
import { NotificationDispatcher } from '../src/notifications/notification-dispatcher';
import { createHarness, Harness } from './harness';

/** Centre de notifications : boîte de réception, e-mails, rappels, préférences. */
describe('Notifications', () => {
  let h: Harness;
  let tenantId: string;
  let realm: string;
  let dispatcher: NotificationDispatcher;
  let mail: LogEmailTransport;
  const host = 'unin.elongo.test';
  const tokens: Record<string, string> = {};
  const users: Record<string, string> = {};
  let invoiceId: string;

  const api = () => request(h.app.getHttpServer());
  const as = (who: string, at = host) => ({ Host: at, Authorization: `Bearer ${tokens[who]}` });
  const inbox = async (who: string, at = host) => (await api().get('/v1/me/notifications').set(as(who, at)).expect(200)).body;
  const kinds = async (who: string) => (await inbox(who)).items.map((n: { kind: string }) => n.kind);

  async function addUser(key: string, roleKey: string, tenant = tenantId, kcRealm = realm, domain = 'unin.cd') {
    const email = `${key}@${domain}`;
    const user = await h.admin.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, full_name, external_id, status) VALUES ($1, $2, $3, $2, 'active') RETURNING id`,
      [tenant, email, `Nom ${key}`],
    );
    users[key] = user.rows[0].id;
    await h.admin.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type)
       SELECT $1, $2, id, 'university' FROM roles WHERE tenant_id = $1 AND key = $3`,
      [tenant, users[key], roleKey],
    );
    tokens[key] = await h.token(kcRealm, { sub: email });
  }

  async function issue(code: string, amount: number, dueOn: string) {
    const fee = await api()
      .post('/v1/fee-structures')
      .set(as('sga'))
      .send({ code, name: code === 'MIN' ? 'Minerval' : `Frais ${code}`, amount, currency: 'USD', dueOn })
      .expect(201);
    await api().post(`/v1/fee-structures/${fee.body.id}/invoices`).set(as('sga')).expect(201);
    return fee.body.id as string;
  }

  beforeAll(async () => {
    h = await createHarness();
    dispatcher = h.app.get(NotificationDispatcher);
    mail = h.app.get(EMAIL_TRANSPORT);
    const platformToken = await h.token('elongo-platform', { sub: 'ops', realm_access: { roles: ['platform-admin'] } });
    const provision = async (slug: string, name: string) =>
      (
        await api()
          .post('/platform/tenants')
          .set('Authorization', `Bearer ${platformToken}`)
          .send({ slug, name, rector: { email: `recteur@${slug}.cd`, fullName: `Recteur ${slug}` } })
          .expect(201)
      ).body;
    const n = await provision('unin', 'Université <N>');
    tenantId = n.id;
    realm = n.keycloakRealm;
    await addUser('sga', 'sg_administration');
    await addUser('etu', 'student');
    await addUser('etu2', 'student');
    tokens.recteur = await h.token(realm, { sub: 'kc-r', email: 'recteur@unin.cd', email_verified: true });
    users.recteur = (await h.admin.query<{ id: string }>(`SELECT id FROM users WHERE email = 'recteur@unin.cd'`)).rows[0].id;

    const o = await provision('unio', 'Université O');
    await addUser('etuo', 'student', o.id, o.keycloakRealm, 'unio.cd');
  });

  afterAll(async () => {
    await h?.close();
  });

  describe('Factures et e-mails', () => {
    it('une facture émise prévient chaque étudiant, et seulement eux', async () => {
      await issue('MIN', 250, '2026-12-15');
      const box = await inbox('etu');
      expect(box.unreadCount).toBe(1);
      expect(box.items[0]).toMatchObject({
        kind: 'invoice.issued',
        category: 'finance',
        title: 'Nouvelle facture : Minerval',
        link: '/espace/paiements',
        readAt: null,
      });
      expect(box.items[0].body).toContain('15 décembre 2026');
      expect(box.items[0].body).toMatch(/250,00\s\$US/);
      expect(await kinds('sga')).toEqual([]);
      invoiceId = (await api().get('/v1/me/invoices').set(as('etu')).expect(200)).body[0].id;
    });

    it("envoie l'e-mail ensuite, aux couleurs de l'université, texte échappé", async () => {
      const queued = await h.admin.query(`SELECT recipient, status FROM notification_deliveries ORDER BY recipient`);
      expect(queued.rows).toEqual([
        { recipient: 'etu2@unin.cd', status: 'pending' },
        { recipient: 'etu@unin.cd', status: 'pending' },
      ]);
      mail.sent.length = 0;
      expect(await dispatcher.runOnce({ scheduled: false })).toEqual({ sent: 2, failed: 0 });
      const email = mail.sent.find((m) => m.to === 'etu@unin.cd')!;
      expect(email).toMatchObject({ from: { name: 'Université <N>' }, subject: 'Nouvelle facture : Minerval' });
      expect(email.text).toContain('https://unin.elongo.test/espace/paiements');
      expect(email.text).toContain('https://unin.elongo.test/espace/notifications');
      expect(email.html).toContain('Université &lt;N&gt;');
      expect(email.html).not.toContain('<N>');
      // Envoyé une seule fois.
      expect(await dispatcher.runOnce({ scheduled: false })).toEqual({ sent: 0, failed: 0 });
      const sent = await h.admin.query(`SELECT count(*)::int AS n FROM notification_deliveries WHERE status = 'sent'`);
      expect(sent.rows[0].n).toBe(2);
    });

    it('réessaie un envoi en échec, puis abandonne après le dernier essai', async () => {
      await h.admin.query(`UPDATE notification_deliveries SET status = 'pending', attempts = 0, next_attempt_at = now(), sent_at = NULL`);
      const send = jest.spyOn(mail, 'send').mockRejectedValue(new Error('SMTP indisponible'));
      try {
        expect(await dispatcher.runOnce({ scheduled: false })).toEqual({ sent: 0, failed: 0 });
        const retry = await h.admin.query(
          `SELECT attempts, status, last_error, next_attempt_at > now() + interval '50 seconds' AS later FROM notification_deliveries`,
        );
        expect(retry.rows[0]).toEqual({ attempts: 1, status: 'pending', last_error: 'SMTP indisponible', later: true });
        // Pas de nouvel essai avant l'heure prévue.
        expect(await dispatcher.runOnce({ scheduled: false })).toEqual({ sent: 0, failed: 0 });
        expect(send).toHaveBeenCalledTimes(2);

        await h.admin.query(`UPDATE notification_deliveries SET attempts = 4, next_attempt_at = now()`);
        expect(await dispatcher.runOnce({ scheduled: false })).toEqual({ sent: 0, failed: 2 });
        const final = await h.admin.query(`SELECT DISTINCT status, attempts FROM notification_deliveries`);
        expect(final.rows).toEqual([{ status: 'failed', attempts: 5 }]);
      } finally {
        send.mockRestore();
      }
    });
  });

  describe('Boîte de réception', () => {
    it('marque une notification lue, ou toutes ; chacun ne touche que les siennes', async () => {
      const [first] = (await inbox('etu')).items;
      await api().post(`/v1/me/notifications/${first.id}/read`).set(as('etu2')).expect(404);
      await api().post('/v1/me/notifications/pas-un-uuid/read').set(as('etu')).expect(400);
      const read = await api().post(`/v1/me/notifications/${first.id}/read`).set(as('etu')).expect(200);
      expect(read.body.readAt).not.toBeNull();
      // Relire ne change pas la date de lecture.
      const again = await api().post(`/v1/me/notifications/${first.id}/read`).set(as('etu')).expect(200);
      expect(again.body.readAt).toBe(read.body.readAt);
      expect((await api().get('/v1/me/notifications/unread-count').set(as('etu')).expect(200)).body).toEqual({ count: 0 });
      expect((await api().get('/v1/me/notifications/unread-count').set(as('etu2')).expect(200)).body).toEqual({ count: 1 });

      await api().post('/v1/me/notifications/read-all').set(as('etu2')).expect(200, { updated: 1 });
      const unread = await api().get('/v1/me/notifications?unread=true').set(as('etu2')).expect(200);
      expect(unread.body).toEqual({ items: [], unreadCount: 0 });
      await api().get('/v1/me/notifications?limit=500').set(as('etu')).expect(400);
    });

    it("une autre université ne voit ni ne lit les notifications d'ici", async () => {
      const [mine] = (await inbox('etu')).items;
      expect(await inbox('etuo', 'unio.elongo.test')).toEqual({ items: [], unreadCount: 0 });
      await api().post(`/v1/me/notifications/${mine.id}/read`).set(as('etuo', 'unio.elongo.test')).expect(404);
      // Sans université fixée, la RLS ne laisse rien voir.
      const raw = await h.appPool.query('SELECT count(*)::int AS n FROM notifications');
      expect(raw.rows[0].n).toBe(0);
    });
  });

  describe('Paiements', () => {
    it('un bordereau prévient le service financier, et sa décision l’étudiant', async () => {
      const account = await api()
        .post('/v1/bank-accounts')
        .set(as('recteur'))
        .send({ bankName: 'Rawbank', accountName: 'Université N', accountNumber: '05100-0001234-56', currency: 'USD' })
        .expect(201);
      const slip = await api()
        .post(`/v1/me/invoices/${invoiceId}/bank-payments`)
        .set({ ...as('etu'), 'Idempotency-Key': 'cle-notif-0001' })
        .field('bankAccountId', account.body.id)
        .field('reference', 'RAW-77')
        .field('paidOn', new Date().toISOString().slice(0, 10))
        .field('amount', '100')
        .attach('slip', Buffer.from('%PDF-1.4\n%%EOF\n'), { filename: 'b.pdf', contentType: 'application/pdf' })
        .expect(201);
      for (const reviewer of ['recteur', 'sga']) {
        const [n] = (await inbox(reviewer)).items;
        expect(n).toMatchObject({ kind: 'bank_payment.declared', category: 'tasks', title: 'Bordereau à valider : Nom etu' });
        expect(n.body).toMatch(/100,00\s\$US déposés chez Rawbank/);
      }
      expect(await kinds('etu2')).not.toContain('bank_payment.declared');

      await api().post(`/v1/bank-payments/${slip.body.id}/reject`).set(as('sga')).send({ reason: 'Bordereau flou' }).expect(200);
      const [rejected] = (await inbox('etu')).items;
      expect(rejected).toMatchObject({ kind: 'bank_payment.rejected', body: expect.stringContaining('Motif : Bordereau flou') });
    });

    it('un paiement Mobile Money confirmé prévient l’étudiant que la facture est réglée', async () => {
      await api().put('/v1/payment-providers/sandbox').set(as('recteur')).send({}).expect(200);
      const start = await api()
        .post(`/v1/me/invoices/${invoiceId}/payments`)
        .set({ ...as('etu'), 'Idempotency-Key': 'cle-notif-0002' })
        .send({ provider: 'sandbox', phone: '+243812345678', returnUrl: `https://${host}/espace/paiements` })
        .expect(201);
      await api().post(`/v1/me/payments/${start.body.id}/sandbox-confirm`).set(as('etu')).send({ outcome: 'succeeded' }).expect(200);
      const [paid] = (await inbox('etu')).items;
      expect(paid).toMatchObject({ kind: 'payment.succeeded', body: 'Votre facture est entièrement réglée.' });
      expect(paid.title).toMatch(/^Paiement reçu : 250,00\s\$US$/);
    });
  });

  describe('Rappels de factures', () => {
    it('rappelle une fois avant l’échéance, relance une fois après, jamais une facture payée', async () => {
      await dispatcher.runOnce({ today: '2026-12-01' });
      expect(await kinds('etu2')).not.toContain('invoice.due_soon');

      await dispatcher.runOnce({ today: '2026-12-13' });
      await dispatcher.runOnce({ today: '2026-12-14' });
      const soon = (await inbox('etu2')).items.filter((n: { kind: string }) => n.kind === 'invoice.due_soon');
      expect(soon).toHaveLength(1);
      expect(soon[0].title).toBe('Rappel : Minerval à régler avant le 15 décembre 2026');

      await dispatcher.runOnce({ today: '2026-12-16' });
      await dispatcher.runOnce({ today: '2026-12-20' });
      expect((await kinds('etu2')).filter((k: string) => k === 'invoice.overdue')).toHaveLength(1);
      // La facture de etu est payée : aucun rappel.
      expect(await kinds('etu')).not.toContain('invoice.due_soon');
      expect(await kinds('etu')).not.toContain('invoice.overdue');
    });

    it('un paiement en attente suspend le rappel', async () => {
      await issue('BIB', 20, '2026-12-28');
      const bib = (await api().get('/v1/me/invoices').set(as('etu')).expect(200)).body.find(
        (i: { feeName: string }) => i.feeName === 'Frais BIB',
      );
      await api()
        .post(`/v1/me/invoices/${bib.id}/payments`)
        .set({ ...as('etu'), 'Idempotency-Key': 'cle-notif-0003' })
        .send({ provider: 'sandbox', phone: '+243812345678', returnUrl: `https://${host}/espace/paiements` })
        .expect(201);
      await dispatcher.runOnce({ today: '2026-12-26' });
      const reminded = await h.admin.query<{ email: string }>(
        `SELECT u.email FROM notifications n JOIN users u ON u.id = n.user_id
          WHERE n.kind = 'invoice.due_soon' AND n.title LIKE '%BIB%' ORDER BY u.email`,
      );
      expect(reminded.rows.map((r) => r.email)).toEqual(['etu2@unin.cd']);
    });
  });

  describe('Préférences', () => {
    it('chacun coupe les e-mails d’une catégorie ; la notification reste dans l’application', async () => {
      const defaults = await api().get('/v1/me/notification-preferences').set(as('etu')).expect(200);
      expect(defaults.body).toEqual([
        { category: 'finance', label: 'Factures et paiements', email: true, push: true },
        { category: 'academic', label: 'Notes et relevés', email: true, push: true },
        { category: 'tasks', label: 'Tâches à traiter', email: true, push: true },
        { category: 'announcements', label: 'Annonces de l’université', email: true, push: true },
      ]);
      await api().put('/v1/me/notification-preferences').set(as('etu')).send({ email: { sport: false } }).expect(400);
      await api().put('/v1/me/notification-preferences').set(as('etu')).send({}).expect(400);

      // Un e-mail déjà en file pour cette catégorie ne part plus.
      await issue('LAB', 15, '2027-01-20');
      const updated = await api()
        .put('/v1/me/notification-preferences')
        .set(as('etu'))
        .send({ email: { finance: false } })
        .expect(200);
      expect(updated.body.find((p: { category: string }) => p.category === 'finance').email).toBe(false);
      const lab = await h.admin.query<{ email: string; status: string }>(
        `SELECT u.email, d.status FROM notification_deliveries d
           JOIN notifications n ON n.id = d.notification_id JOIN users u ON u.id = n.user_id
          WHERE n.title LIKE '%LAB%' ORDER BY u.email`,
      );
      expect(lab.rows).toEqual([
        { email: 'etu2@unin.cd', status: 'pending' },
        { email: 'etu@unin.cd', status: 'failed' },
      ]);

      await issue('SPO', 5, '2027-01-25');
      const spo = await h.admin.query<{ email: string }>(
        `SELECT u.email FROM notification_deliveries d
           JOIN notifications n ON n.id = d.notification_id JOIN users u ON u.id = n.user_id
          WHERE n.title LIKE '%SPO%'`,
      );
      expect(spo.rows.map((r) => r.email)).toEqual(['etu2@unin.cd']);
      expect((await inbox('etu')).items[0].title).toBe('Nouvelle facture : Frais SPO');
      // Les préférences ne fuient pas d'un compte à l'autre.
      const other = await api().get('/v1/me/notification-preferences').set(as('etu2')).expect(200);
      expect(other.body.every((p: { email: boolean }) => p.email)).toBe(true);
    });
  });

  describe('Annonces', () => {
    it('diffuse une annonce à sa publication, une seule fois, sauf à son auteur', async () => {
      const later = new Date(Date.now() + 3_600_000).toISOString();
      const a = await api()
        .post('/v1/announcements')
        .set(as('recteur'))
        .send({ title: 'Rentrée <b>académique</b>', body: 'Les cours reprennent lundi.', visibility: 'campus', publishedAt: later })
        .expect(201);
      await dispatcher.runOnce({ scheduled: true });
      expect(await kinds('etu')).not.toContain('announcement.published');

      await h.admin.query(`UPDATE announcements SET published_at = now() - interval '1 minute' WHERE id = $1`, [a.body.id]);
      mail.sent.length = 0;
      await dispatcher.runOnce({ scheduled: true });
      await dispatcher.runOnce({ scheduled: true });
      const received = await h.admin.query<{ user_id: string }>(
        `SELECT user_id FROM notifications WHERE kind = 'announcement.published' ORDER BY user_id`,
      );
      expect(received.rows.map((r) => r.user_id)).toEqual([users.sga, users.etu, users.etu2].sort());
      const email = mail.sent.find((m) => m.subject === 'Rentrée <b>académique</b>')!;
      expect(email.html).toContain('Rentrée &lt;b&gt;académique&lt;/b&gt;');
      expect(email.html).not.toContain('<b>académique');
    });
  });
});
