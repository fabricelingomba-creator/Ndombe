import request from 'supertest';
import { createHarness, Harness } from './harness';

/** Paiement par banque : comptes de l'université, dépôt du bordereau, validation ou refus. */
describe('Paiement par banque', () => {
  let h: Harness;
  let tenantId: string;
  let realm: string;
  const host = 'unib.elongo.test';
  const tokens: Record<string, string> = {};
  const users: Record<string, string> = {};
  let usdAccount: string;
  let cdfAccount: string;
  let invoiceId: string;
  let otherInvoiceId: string;
  let paymentId: string;

  const api = () => request(h.app.getHttpServer());
  const as = (who: string) => ({ Host: host, Authorization: `Bearer ${tokens[who]}` });
  /** Faux fichiers reconnus par leur signature. */
  const pdf = (n: number) => Buffer.from(`%PDF-1.4\n% bordereau ${n}\n%%EOF\n`);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('donnees')]);

  function declare(
    who: string,
    invoice: string,
    fields: Record<string, string>,
    file: Buffer | null,
    key = `cle-${Math.random().toString(36).slice(2, 12)}`,
  ) {
    let req = api()
      .post(`/v1/me/invoices/${invoice}/bank-payments`)
      .set({ ...as(who), 'Idempotency-Key': key });
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    if (file) req = req.attach('slip', file, { filename: 'bordereau.pdf', contentType: 'application/pdf' });
    return req;
  }
  const today = new Date().toISOString().slice(0, 10);
  const valid = (n: number) => ({ bankAccountId: usdAccount, reference: `RAW-2026-${n}`, paidOn: today, amount: '250' });

  async function addUser(key: string, roleKey: string) {
    const email = `${key}@unib.cd`;
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
      .send({ slug: 'unib', name: 'Université B', rector: { email: 'recteur@unib.cd', fullName: 'Recteur B' } })
      .expect(201);
    tenantId = res.body.id;
    realm = res.body.keycloakRealm;
    await addUser('sga', 'sg_administration');
    await addUser('sgacad', 'sg_academic');
    await addUser('etu', 'student');
    await addUser('etu2', 'student');
    tokens.recteur = await h.token(realm, { sub: 'kc-r', email: 'recteur@unib.cd', email_verified: true });

    const fee = await api()
      .post('/v1/fee-structures')
      .set(as('sga'))
      .send({ code: 'MIN', name: 'Minerval', amount: 250, currency: 'USD', dueOn: '2026-11-30' })
      .expect(201);
    await api().post(`/v1/fee-structures/${fee.body.id}/invoices`).set(as('sga')).expect(201);
    invoiceId = (await api().get('/v1/me/invoices').set(as('etu')).expect(200)).body[0].id;
    otherInvoiceId = (await api().get('/v1/me/invoices').set(as('etu2')).expect(200)).body[0].id;
  });

  afterAll(async () => {
    await h?.close();
  });

  describe('Comptes bancaires', () => {
    it('seul le recteur déclare les comptes ; les étudiants voient les comptes actifs', async () => {
      const body = { bankName: 'Rawbank', accountName: 'Université B', accountNumber: '05100-0001234-56', currency: 'USD' };
      await api().post('/v1/bank-accounts').set(as('sga')).send(body).expect(403);
      await api().post('/v1/bank-accounts').set(as('recteur')).send({ ...body, accountNumber: '<script>' }).expect(400);
      usdAccount = (await api().post('/v1/bank-accounts').set(as('recteur')).send(body).expect(201)).body.id;
      await api().post('/v1/bank-accounts').set(as('recteur')).send(body).expect(409);
      cdfAccount = (
        await api()
          .post('/v1/bank-accounts')
          .set(as('recteur'))
          .send({ ...body, bankName: 'Equity BCDC', accountNumber: '0001-CDF-778', currency: 'CDF' })
          .expect(201)
      ).body.id;
      const closed = (
        await api()
          .post('/v1/bank-accounts')
          .set(as('recteur'))
          .send({ ...body, bankName: 'Ancienne banque', accountNumber: '999-000-111' })
          .expect(201)
      ).body.id;
      await api().put(`/v1/bank-accounts/${closed}`).set(as('recteur')).send({ enabled: false }).expect(200);

      const mine = await api().get('/v1/me/bank-accounts').set(as('etu')).expect(200);
      expect(mine.body.map((a: { bankName: string }) => a.bankName)).toEqual(['Equity BCDC', 'Rawbank']);
      await api().get('/v1/bank-accounts').set(as('etu')).expect(403);
    });
  });

  describe('Dépôt du bordereau', () => {
    it('exige le fichier, un vrai PDF ou une image, une date plausible et la bonne devise', async () => {
      await declare('etu', invoiceId, valid(1), null).expect(400);
      await declare('etu', invoiceId, valid(1), Buffer.from('<html>pas un bordereau</html>')).expect(422);
      await declare('etu', invoiceId, { ...valid(1), paidOn: '2099-01-01' }, pdf(1)).expect(422);
      await declare('etu', invoiceId, { ...valid(1), reference: 'x' }, pdf(1)).expect(400);
      await declare('etu', invoiceId, { ...valid(1), bankAccountId: cdfAccount }, pdf(1)).expect(422);
      await declare('etu', invoiceId, { ...valid(1), amount: '300' }, pdf(1)).expect(422);
      await declare('etu', otherInvoiceId, valid(1), pdf(1)).expect(404);
      const big = Buffer.concat([pdf(1), Buffer.alloc(5 * 1024 * 1024)]);
      await declare('etu', invoiceId, valid(1), big).expect(413);
      const count = await h.admin.query('SELECT count(*)::int AS n FROM payments');
      expect(count.rows[0].n).toBe(0);
    });

    it('enregistre le bordereau en attente ; un double envoi renvoie le même paiement', async () => {
      const first = await declare('etu', invoiceId, valid(1), pdf(1), 'cle-depot-0001').expect(201);
      expect(first.body).toMatchObject({ provider: 'bank', status: 'pending', amountMinor: 25000, replayed: false });
      paymentId = first.body.id;
      const again = await declare('etu', invoiceId, valid(1), pdf(1), 'cle-depot-0001').expect(201);
      expect(again.body).toMatchObject({ id: paymentId, replayed: true });

      // Un second bordereau, ou un paiement Mobile Money, attend la décision.
      await declare('etu', invoiceId, valid(2), pdf(2)).expect(409);
      await api().put('/v1/payment-providers/sandbox').set(as('recteur')).send({}).expect(200);
      await api()
        .post(`/v1/me/invoices/${invoiceId}/payments`)
        .set({ ...as('etu'), 'Idempotency-Key': 'cle-mm-0001' })
        .send({ provider: 'sandbox', phone: '+243812345678', returnUrl: `https://${host}/espace/paiements` })
        .expect(409);

      const mine = await api().get('/v1/me/invoices').set(as('etu')).expect(200);
      expect(mine.body[0].status).toBe('open');
      expect(mine.body[0].payments).toEqual([
        expect.objectContaining({ id: paymentId, status: 'pending', slipReference: 'RAW-2026-1', bankName: 'Rawbank' }),
      ]);
    });

    it("refuse un bordereau déjà soumis, même numéro ou même fichier, par un autre étudiant", async () => {
      const sameRef = await declare('etu2', otherInvoiceId, { ...valid(1), reference: 'raw-2026-1' }, pdf(9)).expect(409);
      expect(sameRef.body.message).toBe('Ce bordereau a déjà été soumis');
      const sameFile = await declare('etu2', otherInvoiceId, valid(3), pdf(1)).expect(409);
      expect(sameFile.body.message).toBe('Ce fichier de bordereau a déjà été soumis');
    });
  });

  describe('Validation par le service financier', () => {
    it("seuls les détenteurs de payments:validate voient les bordereaux et le fichier", async () => {
      await api().get('/v1/bank-payments').set(as('etu')).expect(403);
      await api().get('/v1/bank-payments').set(as('sgacad')).expect(403);
      const queue = await api().get('/v1/bank-payments').set(as('sga')).expect(200);
      expect(queue.body).toEqual([
        expect.objectContaining({
          id: paymentId,
          reference: 'RAW-2026-1',
          studentName: 'Nom etu',
          bankName: 'Rawbank',
          amountMinor: 25000,
          decision: null,
        }),
      ]);
      expect(queue.body[0]).not.toHaveProperty('file');

      const file = await api()
        .get(`/v1/bank-payments/${paymentId}/slip`)
        .set(as('sga'))
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(file.headers['content-type']).toBe('application/pdf');
      expect(file.headers['content-security-policy']).toContain('sandbox');
      expect((file.body as Buffer).equals(pdf(1))).toBe(true);
      await api().get(`/v1/bank-payments/${paymentId}/slip`).set(as('etu')).expect(403);
    });

    it('un refus exige un motif, que l’étudiant voit, et libère le numéro du bordereau', async () => {
      await api().post(`/v1/bank-payments/${paymentId}/reject`).set(as('sga')).send({ reason: '' }).expect(400);
      await api()
        .post(`/v1/bank-payments/${paymentId}/reject`)
        .set(as('sga'))
        .send({ reason: 'Bordereau illisible, renvoyez une photo nette' })
        .expect(200, { decision: 'rejected', invoiceStatus: 'open' });
      await api().post(`/v1/bank-payments/${paymentId}/accept`).set(as('sga')).expect(409);

      const mine = await api().get('/v1/me/invoices').set(as('etu')).expect(200);
      expect(mine.body[0].payments[0]).toMatchObject({
        status: 'failed',
        failureReason: 'Bordereau illisible, renvoyez une photo nette',
      });
      // Le même numéro peut être renvoyé avec une photo nette.
      paymentId = (await declare('etu', invoiceId, valid(1), png).expect(201)).body.id;
    });

    it('la validation règle la facture ; une décision est définitive', async () => {
      const res = await api().post(`/v1/bank-payments/${paymentId}/accept`).set(as('sga')).expect(200);
      expect(res.body).toEqual({ decision: 'accepted', invoiceStatus: 'paid' });
      await api().post(`/v1/bank-payments/${paymentId}/reject`).set(as('sga')).send({ reason: 'trop tard' }).expect(409);

      const mine = await api().get('/v1/me/invoices').set(as('etu')).expect(200);
      expect(mine.body[0]).toMatchObject({ status: 'paid', paidMinor: 25000 });
      const accepted = await api().get('/v1/bank-payments?status=accepted').set(as('recteur')).expect(200);
      expect(accepted.body).toEqual([expect.objectContaining({ id: paymentId, reviewerName: 'Nom sga' })]);

      const client = await h.appPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
        await expect(
          client.query(`UPDATE bank_slips SET decision = 'rejected' WHERE payment_id = $1`, [paymentId]),
        ).rejects.toThrow(/déjà traité/);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('personne ne valide son propre bordereau', async () => {
      // Le SG administratif est aussi étudiant (formation continue).
      await h.admin.query(
        `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type)
         SELECT $1, $2, id, 'university' FROM roles WHERE tenant_id = $1 AND key = 'student'`,
        [tenantId, users.sga],
      );
      const fee = await api()
        .post('/v1/fee-structures')
        .set(as('sga'))
        .send({ code: 'LAB', name: 'Laboratoire', amount: 20, currency: 'USD', dueOn: '2026-12-15' })
        .expect(201);
      await api().post(`/v1/fee-structures/${fee.body.id}/invoices`).set(as('sga')).expect(201);
      const own = (await api().get('/v1/me/invoices').set(as('sga')).expect(200)).body[0];
      const declared = await declare('sga', own.id, { ...valid(7), amount: '20' }, pdf(7)).expect(201);
      await api().post(`/v1/bank-payments/${declared.body.id}/accept`).set(as('sga')).expect(403);
      await api().post(`/v1/bank-payments/${declared.body.id}/accept`).set(as('recteur')).expect(200);
    });
  });

  describe('Isolation et audit', () => {
    it("une autre université ne voit ni les comptes ni les bordereaux", async () => {
      const platformToken = await h.token('elongo-platform', { sub: 'ops', realm_access: { roles: ['platform-admin'] } });
      const other = await api()
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${platformToken}`)
        .send({ slug: 'unic', name: 'Université C', rector: { email: 'recteur@unic.cd', fullName: 'Recteur C' } })
        .expect(201);
      const rectorC = await h.token(other.body.keycloakRealm, { sub: 'kc-c', email: 'recteur@unic.cd', email_verified: true });
      const headers = { Host: 'unic.elongo.test', Authorization: `Bearer ${rectorC}` };
      expect((await api().get('/v1/bank-accounts').set(headers).expect(200)).body).toEqual([]);
      expect((await api().get('/v1/bank-payments?status=accepted').set(headers).expect(200)).body).toEqual([]);
      await api().get(`/v1/bank-payments/${paymentId}/slip`).set(headers).expect(404);
      await api().post(`/v1/bank-payments/${paymentId}/reject`).set(headers).send({ reason: 'intrusion' }).expect(404);
    });

    it("l'audit trace dépôt, refus et validation, sans le fichier", async () => {
      const res = await api().get('/v1/audit-logs').set(as('recteur')).expect(200);
      const actions = res.body.map((e: { action: string }) => e.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'bank_account.created',
          'bank_account.disabled',
          'bank_payment.declared',
          'bank_payment.rejected',
          'bank_payment.accepted',
        ]),
      );
      expect(JSON.stringify(res.body)).not.toContain('PDF-1.4');
      await api().get('/v1/audit-logs/verify').set(as('recteur')).expect(200, { intact: true, brokenAt: null });
    });
  });
});
