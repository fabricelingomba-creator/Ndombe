import request from 'supertest';
import { createHarness, Harness } from './harness';

/** Portées RBAC : un SG académique de faculté n'agit que sur sa faculté. */
describe('RBAC avec portées', () => {
  let h: Harness;
  let tenantId: string;
  let realm: string;
  const host = 'unic.elongo.test';
  let rectorToken: string;
  let sgFacToken: string;
  let studentToken: string;
  let sciences: string;
  let droit: string;

  const api = () => request(h.app.getHttpServer());

  async function addUser(email: string, roleKey: string, scope: { type: string; id: string | null }) {
    const user = await h.admin.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, full_name, external_id, status) VALUES ($1, $2, $2, $2, 'active') RETURNING id`,
      [tenantId, email],
    );
    await h.admin.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id)
       SELECT $1, $2, id, $4, $5 FROM roles WHERE tenant_id = $1 AND key = $3`,
      [tenantId, user.rows[0].id, roleKey, scope.type, scope.id],
    );
    return h.token(realm, { sub: email });
  }

  beforeAll(async () => {
    h = await createHarness();
    const platformToken = await h.token('elongo-platform', { sub: 'ops', realm_access: { roles: ['platform-admin'] } });
    const res = await api()
      .post('/platform/tenants')
      .set('Authorization', `Bearer ${platformToken}`)
      .send({ slug: 'unic', name: 'Université C', rector: { email: 'recteur@unic.cd', fullName: 'Recteur C' } })
      .expect(201);
    tenantId = res.body.id;
    realm = res.body.keycloakRealm;
    rectorToken = await h.token(realm, { sub: 'kc-rector', email: 'recteur@unic.cd', email_verified: true });

    const create = async (code: string) =>
      (
        await api()
          .post('/v1/faculties')
          .set('Host', host)
          .set('Authorization', `Bearer ${rectorToken}`)
          .send({ code, name: code })
          .expect(201)
      ).body.id as string;
    sciences = await create('SCI');
    droit = await create('DROIT');

    sgFacToken = await addUser('sg.sciences@unic.cd', 'sg_academic', { type: 'faculty', id: sciences });
    studentToken = await addUser('etudiant@unic.cd', 'student', { type: 'university', id: null });
  });

  afterAll(async () => {
    await h?.close();
  });

  it('le SG de faculté crée un département dans sa faculté', async () => {
    await api()
      .post(`/v1/faculties/${sciences}/departments`)
      .set('Host', host)
      .set('Authorization', `Bearer ${sgFacToken}`)
      .send({ code: 'MATH', name: 'Mathématiques' })
      .expect(201);
  });

  it("le SG de faculté ne peut rien créer dans une autre faculté", async () => {
    await api()
      .post(`/v1/faculties/${droit}/departments`)
      .set('Host', host)
      .set('Authorization', `Bearer ${sgFacToken}`)
      .send({ code: 'PRIV', name: 'Droit privé' })
      .expect(403);
  });

  it("le SG de faculté ne peut pas créer de faculté (action d'université)", async () => {
    await api()
      .post('/v1/faculties')
      .set('Host', host)
      .set('Authorization', `Bearer ${sgFacToken}`)
      .send({ code: 'MED', name: 'Médecine' })
      .expect(403);
  });

  it("un étudiant ne lit pas l'audit et ne modifie pas la structure", async () => {
    await api().get('/v1/audit-logs').set('Host', host).set('Authorization', `Bearer ${studentToken}`).expect(403);
    await api()
      .post('/v1/faculties')
      .set('Host', host)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ code: 'X', name: 'X' })
      .expect(403);
  });

  it('un identifiant de faculté mal formé est rejeté avant toute requête', async () => {
    await api()
      .get('/v1/faculties/pas-un-uuid/departments')
      .set('Host', host)
      .set('Authorization', `Bearer ${sgFacToken}`)
      .expect(400);
  });

  describe("Journal d'audit", () => {
    it('trace chaque création avec son auteur', async () => {
      const res = await api().get('/v1/audit-logs').set('Host', host).set('Authorization', `Bearer ${rectorToken}`).expect(200);
      expect(res.body.map((e: { action: string }) => e.action)).toEqual([
        'department.created',
        'faculty.created',
        'faculty.created',
        'tenant.provisioned',
      ]);
      expect(res.body[0].actorUserId).toBeTruthy();
    });

    it('la chaîne de hash est intacte', async () => {
      const res = await api().get('/v1/audit-logs/verify').set('Host', host).set('Authorization', `Bearer ${rectorToken}`).expect(200);
      expect(res.body).toEqual({ intact: true, brokenAt: null });
    });

    it("l'API ne peut ni modifier ni supprimer une entrée", async () => {
      const client = await h.appPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
        await expect(client.query(`UPDATE audit_log SET action = 'x'`)).rejects.toThrow(/permission denied/);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('même le propriétaire de la base est bloqué par le trigger', async () => {
      await expect(h.admin.query(`DELETE FROM audit_log`)).rejects.toThrow(/ajout seul/);
    });

    it('une altération directe est détectée', async () => {
      await h.admin.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only');
      await h.admin.query(`UPDATE audit_log SET after = '{"code":"FAUX"}' WHERE action = 'department.created'`);
      await h.admin.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only');
      const res = await api().get('/v1/audit-logs/verify').set('Host', host).set('Authorization', `Bearer ${rectorToken}`).expect(200);
      expect(res.body.intact).toBe(false);
      expect(res.body.brokenAt).toBeTruthy();
    });
  });
});
