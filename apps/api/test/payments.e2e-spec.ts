import request from 'supertest';
import { signPayload } from '../src/payments/providers/signature';
import { createHarness, Harness } from './harness';

/** Frais, factures, paiement Mobile Money (simulé), webhooks signés. */
describe('Paiements', () => {
  let h: Harness;
  let tenantId: string;
  let realm: string;
  const host = 'unip.elongo.test';
  const returnUrl = `https://${host}/espace/paiements`;
  const tokens: Record<string, string> = {};
  const users: Record<string, string> = {};
  let sandboxSecret: string;
  let feeId: string;
  let invoiceId: string;
  let otherInvoiceId: string;

  const api = () => request(h.app.getHttpServer());
  const as = (who: string) => ({ Host: host, Authorization: `Bearer ${tokens[who]}` });

  function signed(secret: string, body: unknown, header: string, t = Math.floor(Date.now() / 1000)) {
    const raw = JSON.stringify(body);
    return { raw, headers: { 'content-type': 'application/json', [header]: `t=${t},v1=${signPayload(secret, t, raw)}` } };
  }

  async function addUser(key: string, roleKey: string) {
    const email = `${key}@unip.cd`;
    const user = await h.admin.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, full_name, external_id, status) VALUES ($1, $2, $3, $2, 'active') RETURNING id`,
      [tenantId, email, `Nom ${key}`],
    );
    users[key] = user.rows[0].id;
    await h.admin.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type)
       SELECT $1, $2, id, 'university' FROM roles WHERE tenant_id = $1 AND key = $3`,
      [tenantId, users[key], roleKey],
    );
    tokens[key] = await h.token(realm, { sub: email });
  }

  beforeAll(async () => {
    h = await createHarness();
    const platformToken = await h.token('elongo-platform', { sub: 'ops', realm_access: { roles: ['platform-admin'] } });
    const res = await api()
      .post('/platform/tenants')
      .set('Authorization', `Bearer ${platformToken}`)
      .send({ slug: 'unip', name: 'Université P', rector: { email: 'recteur@unip.cd', fullName: 'Recteur P' } })
      .expect(201);
    tenantId = res.body.id;
    realm = res.body.keycloakRealm;
    await addUser('sga', 'sg_administration');
    await addUser('etu', 'student');
    await addUser('etu2', 'student');
    tokens.recteur = await h.token(realm, { sub: 'kc-r', email: 'recteur@unip.cd', email_verified: true });
  });

  afterAll(async () => {
    await h?.close();
  });

  describe('Configuration', () => {
    it('seul le recteur active un prestataire ; le secret sandbox est renvoyé une fois', async () => {
      await api().put('/v1/payment-providers/sandbox').set(as('sga')).send({}).expect(403);
      const res = await api().put('/v1/payment-providers/sandbox').set(as('recteur')).send({}).expect(200);
      expect(res.body).toMatchObject({ provider: 'sandbox', enabled: true, webhookUrl: '/webhooks/payments/sandbox/unip' });
      sandboxSecret = res.body.webhookSecret;
      expect(sandboxSecret).toMatch(/^sbx_whsec_/);

      const list = await api().get('/v1/payment-providers').set(as('recteur')).expect(200);
      expect(list.body).toEqual([expect.objectContaining({ provider: 'sandbox', enabled: true })]);
      expect(JSON.stringify(list.body)).not.toContain(sandboxSecret);
    });

    it('refuse un prestataire inconnu', async () => {
      await api().put('/v1/payment-providers/stripe').set(as('recteur')).send({}).expect(404);
      await api().put('/v1/payment-providers/inconnu').set(as('recteur')).send({}).expect(404);
    });

    it('le SG administratif crée un frais et émet les factures des étudiants', async () => {
      await api()
        .post('/v1/fee-structures')
        .set(as('sga'))
        .send({ code: 'MIN', name: 'Minerval', amount: 12.345, currency: 'USD', dueOn: '2026-11-30' })
        .expect(400);
      await api()
        .post('/v1/fee-structures')
        .set(as('etu'))
        .send({ code: 'MIN', name: 'Minerval', amount: 250, currency: 'USD', dueOn: '2026-11-30' })
        .expect(403);
      const fee = await api()
        .post('/v1/fee-structures')
        .set(as('sga'))
        .send({ code: 'MIN', name: 'Minerval', amount: 250.5, currency: 'USD', dueOn: '2026-11-30' })
        .expect(201);
      feeId = fee.body.id;
      expect(fee.body).toMatchObject({ amountMinor: 25050, currency: 'USD', dueOn: '2026-11-30' });

      const issued = await api().post(`/v1/fee-structures/${feeId}/invoices`).set(as('sga')).expect(201);
      expect(issued.body).toEqual({ created: 2 });
      // Ré-émettre ne crée pas de doublon.
      expect((await api().post(`/v1/fee-structures/${feeId}/invoices`).set(as('sga')).expect(201)).body).toEqual({
        created: 0,
      });

      const mine = await api().get('/v1/me/invoices').set(as('etu')).expect(200);
      expect(mine.body).toEqual([
        expect.objectContaining({ feeName: 'Minerval', amountMinor: 25050, paidMinor: 0, status: 'open', payments: [] }),
      ]);
      invoiceId = mine.body[0].id;
      otherInvoiceId = (await api().get('/v1/me/invoices').set(as('etu2')).expect(200)).body[0].id;

      const options = await api().get('/v1/me/payment-options').set(as('etu')).expect(200);
      expect(options.body.map((o: { provider: string }) => o.provider)).toEqual(['sandbox']);
    });
  });

  describe('Mobile Money (simulé)', () => {
    let paymentId: string;

    it("exige une clé d'idempotence, un numéro et une adresse de retour de l'université", async () => {
      const url = `/v1/me/invoices/${invoiceId}/payments`;
      await api().post(url).set(as('etu')).send({ provider: 'sandbox', phone: '+243812345678', returnUrl }).expect(400);
      await api()
        .post(url)
        .set({ ...as('etu'), 'Idempotency-Key': 'cle-test-0001' })
        .send({ provider: 'sandbox', returnUrl })
        .expect(422);
      await api()
        .post(url)
        .set({ ...as('etu'), 'Idempotency-Key': 'cle-test-0001' })
        .send({ provider: 'sandbox', phone: '+243812345678', returnUrl: 'https://pirate.example/x' })
        .expect(422);
      // La facture d'un autre étudiant est invisible.
      await api()
        .post(`/v1/me/invoices/${otherInvoiceId}/payments`)
        .set({ ...as('etu'), 'Idempotency-Key': 'cle-test-0001' })
        .send({ provider: 'sandbox', phone: '+243812345678', returnUrl })
        .expect(404);
    });

    it('un double clic renvoie le même paiement ; une autre tentative est bloquée', async () => {
      const send = (key: string) =>
        api()
          .post(`/v1/me/invoices/${invoiceId}/payments`)
          .set({ ...as('etu'), 'Idempotency-Key': key })
          .send({ provider: 'sandbox', phone: '+243812345678', returnUrl });
      const first = await send('cle-test-0001').expect(201);
      expect(first.body).toMatchObject({ status: 'pending', amountMinor: 25050, currency: 'USD', replayed: false });
      expect(first.body.instructions).toContain('+243812345678');
      paymentId = first.body.id;

      const again = await send('cle-test-0001').expect(201);
      expect(again.body).toMatchObject({ id: paymentId, replayed: true });
      await send('cle-test-0002').expect(409);
      const count = await h.admin.query('SELECT count(*)::int AS n FROM payments WHERE invoice_id = $1', [invoiceId]);
      expect(count.rows[0].n).toBe(1);
    });

    it('rejette un webhook mal signé, trop ancien, ou pour une université inconnue', async () => {
      const event = { id: 'evt_x', type: 'payment.succeeded', data: { reference: `sbx_${paymentId}`, amount_minor: 25050 } };
      const bad = signed('mauvais-secret', event, 'x-sandbox-signature');
      await api().post('/webhooks/payments/sandbox/unip').set(bad.headers).send(bad.raw).expect(400);
      const old = signed(sandboxSecret, event, 'x-sandbox-signature', Math.floor(Date.now() / 1000) - 3600);
      await api().post('/webhooks/payments/sandbox/unip').set(old.headers).send(old.raw).expect(400);
      const good = signed(sandboxSecret, event, 'x-sandbox-signature');
      await api().post('/webhooks/payments/sandbox/inconnue').set(good.headers).send(good.raw).expect(404);
      await api().post('/webhooks/payments/paypal/unip').set(good.headers).send(good.raw).expect(404);
      const status = await api().get(`/v1/me/payments/${paymentId}`).set(as('etu')).expect(200);
      expect(status.body.status).toBe('pending');
    });

    it('un montant différent est refusé et tracé, sans régler la facture', async () => {
      const { raw, headers } = signed(
        sandboxSecret,
        { id: 'evt_montant', type: 'payment.succeeded', data: { reference: `sbx_${paymentId}`, amount_minor: 100 } },
        'x-sandbox-signature',
      );
      const res = await api().post('/webhooks/payments/sandbox/unip').set(headers).send(raw).expect(200);
      expect(res.body).toEqual({ received: true, outcome: 'amount_mismatch' });
      expect((await api().get(`/v1/me/payments/${paymentId}`).set(as('etu')).expect(200)).body.status).toBe('pending');
    });

    it('le webhook signé règle le paiement et la facture ; rejoué, il ne change rien', async () => {
      const { raw, headers } = signed(
        sandboxSecret,
        {
          id: 'evt_ok',
          type: 'payment.succeeded',
          data: { reference: `sbx_${paymentId}`, amount_minor: 25050, currency: 'USD' },
        },
        'x-sandbox-signature',
      );
      const res = await api().post('/webhooks/payments/sandbox/unip').set(headers).send(raw).expect(200);
      expect(res.body.outcome).toBe('applied');
      const replay = await api().post('/webhooks/payments/sandbox/unip').set(headers).send(raw).expect(200);
      expect(replay.body.outcome).toBe('duplicate');

      const mine = await api().get('/v1/me/invoices').set(as('etu')).expect(200);
      expect(mine.body[0]).toMatchObject({ status: 'paid', paidMinor: 25050 });
      expect(mine.body[0].payments).toEqual([expect.objectContaining({ id: paymentId, status: 'succeeded' })]);

      // Un échec tardif ne défait pas un paiement abouti.
      const late = signed(
        sandboxSecret,
        { id: 'evt_tard', type: 'payment.failed', data: { reference: `sbx_${paymentId}` } },
        'x-sandbox-signature',
      );
      expect((await api().post('/webhooks/payments/sandbox/unip').set(late.headers).send(late.raw)).body.outcome).toBe(
        'already_final',
      );
      // Facture réglée : plus de nouveau paiement.
      await api()
        .post(`/v1/me/invoices/${invoiceId}/payments`)
        .set({ ...as('etu'), 'Idempotency-Key': 'cle-test-0003' })
        .send({ provider: 'sandbox', phone: '+243812345678', returnUrl })
        .expect(409);
    });

    it('un paiement abouti est définitif, même en base', async () => {
      const client = await h.appPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
        await expect(client.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [paymentId])).rejects.toThrow(
          /définitif/,
        );
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it("la confirmation simulée passe par le même webhook signé", async () => {
      const start = await api()
        .post(`/v1/me/invoices/${otherInvoiceId}/payments`)
        .set({ ...as('etu2'), 'Idempotency-Key': 'cle-etu2-0001' })
        .send({ provider: 'sandbox', phone: '+243899999999', returnUrl })
        .expect(201);
      await api()
        .post(`/v1/me/payments/${start.body.id}/sandbox-confirm`)
        .set(as('etu'))
        .send({ outcome: 'succeeded' })
        .expect(404);
      const res = await api()
        .post(`/v1/me/payments/${start.body.id}/sandbox-confirm`)
        .set(as('etu2'))
        .send({ outcome: 'failed' })
        .expect(200);
      expect(res.body).toEqual({ outcome: 'applied' });
      const payment = await api().get(`/v1/me/payments/${start.body.id}`).set(as('etu2')).expect(200);
      expect(payment.body).toMatchObject({ status: 'failed', failureReason: 'Refusé sur le téléphone' });
    });
  });

  describe('Robustesse', () => {
    it("rattrape un webhook arrivé avant l'enregistrement de la référence", async () => {
      const start = await api()
        .post(`/v1/me/invoices/${otherInvoiceId}/payments`)
        .set({ ...as('etu2'), 'Idempotency-Key': 'cle-etu2-0002' })
        .send({ provider: 'sandbox', phone: '+243899999999', returnUrl })
        .expect(201);
      await h.admin.query('UPDATE payments SET provider_ref = NULL WHERE id = $1', [start.body.id]);

      const { raw, headers } = signed(
        sandboxSecret,
        {
          id: 'evt_tot',
          type: 'payment.succeeded',
          data: { reference: 'sbx_ref_tardive', payment_id: start.body.id, amount_minor: 25050, currency: 'USD' },
        },
        'x-sandbox-signature',
      );
      expect((await api().post('/webhooks/payments/sandbox/unip').set(headers).send(raw)).body.outcome).toBe('applied');
      const stored = await h.admin.query('SELECT status, provider_ref FROM payments WHERE id = $1', [start.body.id]);
      expect(stored.rows[0]).toEqual({ status: 'succeeded', provider_ref: 'sbx_ref_tardive' });
      const mine = await api().get('/v1/me/invoices').set(as('etu2')).expect(200);
      expect(mine.body[0]).toMatchObject({ status: 'paid', paidMinor: 25050 });
    });

    it("un moyen de paiement désactivé n'est plus proposé ni utilisable", async () => {
      const fee = await api()
        .post('/v1/fee-structures')
        .set(as('sga'))
        .send({ code: 'LAB', name: 'Laboratoire', amount: 5, currency: 'USD', dueOn: '2026-12-20' })
        .expect(201);
      await api().post(`/v1/fee-structures/${fee.body.id}/invoices`).set(as('sga')).expect(201);
      const invoice = (await api().get('/v1/me/invoices').set(as('etu')).expect(200)).body.find(
        (i: { feeCode: string }) => i.feeCode === 'LAB',
      );
      await api().put('/v1/payment-providers/sandbox').set(as('recteur')).send({ enabled: false }).expect(200);
      expect((await api().get('/v1/me/payment-options').set(as('etu')).expect(200)).body).toEqual([]);
      await api()
        .post(`/v1/me/invoices/${invoice.id}/payments`)
        .set({ ...as('etu'), 'Idempotency-Key': 'cle-etu-lab-1' })
        .send({ provider: 'sandbox', phone: '+243812345678', returnUrl })
        .expect(404);
      // Réactivé : nouveau secret de webhook, l'ancien ne vaut plus.
      const res = await api().put('/v1/payment-providers/sandbox').set(as('recteur')).send({}).expect(200);
      const old = signed(sandboxSecret, { id: 'evt_old', type: 'payment.failed', data: {} }, 'x-sandbox-signature');
      await api().post('/webhooks/payments/sandbox/unip').set(old.headers).send(old.raw).expect(400);
      sandboxSecret = res.body.webhookSecret;
    });
  });

  describe('Suivi et isolation', () => {
    it('le SG administratif voit les factures ; un étudiant non', async () => {
      await api().get('/v1/invoices').set(as('etu')).expect(403);
      const paid = await api().get('/v1/invoices?status=paid').set(as('sga')).expect(200);
      expect(paid.body.map((i: { studentName: string }) => i.studentName).sort()).toEqual(['Nom etu', 'Nom etu2']);
      await api().get('/v1/invoices?status=nimporte').set(as('sga')).expect(400);
    });

    it("une autre université ne voit ni les factures, ni les paiements, ni les prestataires", async () => {
      const platformToken = await h.token('elongo-platform', { sub: 'ops', realm_access: { roles: ['platform-admin'] } });
      const other = await api()
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${platformToken}`)
        .send({ slug: 'uniq', name: 'Université Q', rector: { email: 'recteur@uniq.cd', fullName: 'Recteur Q' } })
        .expect(201);
      const rectorQ = await h.token(other.body.keycloakRealm, { sub: 'kc-q', email: 'recteur@uniq.cd', email_verified: true });
      const headers = { Host: 'uniq.elongo.test', Authorization: `Bearer ${rectorQ}` };
      expect((await api().get('/v1/invoices').set(headers).expect(200)).body).toEqual([]);
      expect((await api().get('/v1/payment-providers').set(headers).expect(200)).body).toEqual([]);
      expect((await api().get('/v1/fee-structures').set(headers).expect(200)).body).toEqual([]);

      // Le webhook d'une université signé avec le secret d'une autre est rejeté.
      const { raw, headers: wh } = signed(
        sandboxSecret,
        { id: 'evt_q', type: 'payment.succeeded', data: { reference: 'sbx_x', amount_minor: 1 } },
        'x-sandbox-signature',
      );
      await api().post('/webhooks/payments/sandbox/uniq').set(wh).send(raw).expect(404);

      const leaked = await h.appPool.query('SELECT count(*)::int AS n FROM payments');
      expect(leaked.rows[0].n).toBe(0);
    });

    it("l'audit trace chaque étape sans jamais contenir de secret, chaîne intacte", async () => {
      const res = await api().get('/v1/audit-logs').set(as('recteur')).expect(200);
      const actions = res.body.map((e: { action: string }) => e.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'payment_provider.configured',
          'fee_structure.created',
          'invoices.issued',
          'payment.started',
          'payment.succeeded',
          'payment.failed',
        ]),
      );
      const dump = JSON.stringify(res.body);
      expect(dump).not.toContain(sandboxSecret);
      await api().get('/v1/audit-logs/verify').set(as('recteur')).expect(200, { intact: true, brokenAt: null });
    });
  });
});
