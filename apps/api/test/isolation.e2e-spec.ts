import request from 'supertest';
import { createHarness, Harness } from './harness';

/**
 * Tests d'isolation entre universités. Ils doivent rester verts pour tout
 * déploiement : une fuite de données entre universités est le pire risque du produit.
 */
describe('Isolation multi-tenant', () => {
  let h: Harness;
  let platformToken: string;
  const tenants: Record<'a' | 'b', { id: string; host: string; realm: string; rectorToken: string }> = {} as never;

  const api = () => request(h.app.getHttpServer());

  beforeAll(async () => {
    h = await createHarness();
    platformToken = await h.token('elongo-platform', {
      sub: 'ops-1',
      email: 'ops@elongo.app',
      realm_access: { roles: ['platform-admin'] },
    });

    for (const key of ['a', 'b'] as const) {
      const res = await api()
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${platformToken}`)
        .send({
          slug: `uni${key}`,
          name: `Université ${key.toUpperCase()}`,
          customDomains: [`portail.uni${key}.ac.cd`],
          branding: { primaryColor: key === 'a' ? '#004080' : '#800000' },
          rector: { email: `recteur@uni${key}.ac.cd`, fullName: `Recteur ${key.toUpperCase()}` },
        })
        .expect(201);
      tenants[key] = {
        id: res.body.id,
        host: `uni${key}.elongo.test`,
        realm: res.body.keycloakRealm,
        rectorToken: await h.token(res.body.keycloakRealm, {
          sub: `kc-rector-${key}`,
          email: `recteur@uni${key}.ac.cd`,
          email_verified: true,
        }),
      };
    }
  });

  afterAll(async () => {
    await h?.close();
  });

  describe('Portail plateforme', () => {
    it('refuse un jeton sans le rôle platform-admin', async () => {
      const token = await h.token('elongo-platform', { sub: 'x', realm_access: { roles: [] } });
      await api().get('/platform/tenants').set('Authorization', `Bearer ${token}`).expect(403);
    });

    it("refuse le jeton d'un Recteur", async () => {
      await api().get('/platform/tenants').set('Authorization', `Bearer ${tenants.a.rectorToken}`).expect(401);
    });

    it('refuse un slug déjà pris', async () => {
      await api()
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${platformToken}`)
        .send({ slug: 'unia', name: 'Doublon', rector: { email: 'x@y.cd', fullName: 'X Y' } })
        .expect(409);
    });
  });

  describe('Résolution du tenant', () => {
    it('sert le manifeste de marque par sous-domaine', async () => {
      const res = await api().get('/v1/tenant/manifest').set('Host', tenants.a.host).expect(200);
      expect(res.body).toMatchObject({
        slug: 'unia',
        name: 'Université A',
        branding: { primaryColor: '#004080' },
        auth: { issuer: 'https://auth.elongo.test/realms/univ-unia' },
      });
    });

    it('sert le manifeste par domaine personnalisé', async () => {
      const res = await api().get('/v1/tenant/manifest').set('Host', 'portail.unib.ac.cd').expect(200);
      expect(res.body.slug).toBe('unib');
      expect(res.body.branding.primaryColor).toBe('#800000');
    });

    it("accepte l'en-tête de l'app mobile quand l'hôte n'est pas un portail", async () => {
      const res = await api().get('/v1/tenant/manifest').set('Host', 'api.elongo.test').set('x-elongo-tenant', 'unib').expect(200);
      expect(res.body.slug).toBe('unib');
    });

    it("le nom d'hôte prime sur l'en-tête", async () => {
      const res = await api().get('/v1/tenant/manifest').set('Host', tenants.a.host).set('x-elongo-tenant', 'unib').expect(200);
      expect(res.body.slug).toBe('unia');
    });

    it('renvoie 404 pour une université inconnue', async () => {
      await api().get('/v1/tenant/manifest').set('Host', 'inconnue.elongo.test').expect(404);
    });

    it('refuse une université suspendue', async () => {
      await h.admin.query(`UPDATE tenants SET status = 'suspended' WHERE slug = 'unib'`);
      try {
        await api().get('/v1/tenant/manifest').set('Host', tenants.b.host).expect(403);
      } finally {
        await h.admin.query(`UPDATE tenants SET status = 'active' WHERE slug = 'unib'`);
      }
    });
  });

  describe('Authentification', () => {
    it("relie le compte Keycloak du Recteur invité à sa première connexion", async () => {
      const res = await api().get('/v1/me').set('Host', tenants.a.host).set('Authorization', `Bearer ${tenants.a.rectorToken}`).expect(200);
      expect(res.body.roles).toEqual(['rector']);
      expect(res.body.permissions).toContain('grades:publish');
      expect(res.body.permissions).not.toContain('self:grades:read');
    });

    it("rejette le jeton de l'université A sur le portail de l'université B", async () => {
      await api().get('/v1/me').set('Host', tenants.b.host).set('Authorization', `Bearer ${tenants.a.rectorToken}`).expect(401);
    });

    it('rejette une requête sans jeton', async () => {
      await api().get('/v1/me').set('Host', tenants.a.host).expect(401);
    });

    it("rejette un jeton valide d'un utilisateur absent de l'annuaire", async () => {
      const token = await h.token(tenants.a.realm, { sub: 'kc-stranger', email: 'intrus@exemple.cd', email_verified: true });
      await api().get('/v1/me').set('Host', tenants.a.host).set('Authorization', `Bearer ${token}`).expect(403);
    });

    it("ne relie pas un compte par e-mail non vérifié", async () => {
      await h.admin.query(
        `INSERT INTO users (tenant_id, email, full_name) VALUES ($1, 'prof@unia.ac.cd', 'Prof A')`,
        [tenants.a.id],
      );
      const token = await h.token(tenants.a.realm, { sub: 'kc-prof', email: 'prof@unia.ac.cd', email_verified: false });
      await api().get('/v1/me').set('Host', tenants.a.host).set('Authorization', `Bearer ${token}`).expect(403);
    });
  });

  describe('Données métier', () => {
    let facultyA: string;

    beforeAll(async () => {
      const res = await api()
        .post('/v1/faculties')
        .set('Host', tenants.a.host)
        .set('Authorization', `Bearer ${tenants.a.rectorToken}`)
        .send({ code: 'SCI', name: 'Faculté des sciences' })
        .expect(201);
      facultyA = res.body.id;
    });

    it("l'université A voit sa faculté", async () => {
      const res = await api().get('/v1/faculties').set('Host', tenants.a.host).set('Authorization', `Bearer ${tenants.a.rectorToken}`).expect(200);
      expect(res.body.map((f: { code: string }) => f.code)).toEqual(['SCI']);
    });

    it("l'université B ne voit rien de l'université A", async () => {
      const res = await api().get('/v1/faculties').set('Host', tenants.b.host).set('Authorization', `Bearer ${tenants.b.rectorToken}`).expect(200);
      expect(res.body).toEqual([]);
    });

    it("B ne peut pas créer de département dans une faculté de A", async () => {
      const res = await api()
        .post(`/v1/faculties/${facultyA}/departments`)
        .set('Host', tenants.b.host)
        .set('Authorization', `Bearer ${tenants.b.rectorToken}`)
        .send({ code: 'MATH', name: 'Mathématiques' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      const count = await h.admin.query('SELECT count(*)::int AS n FROM departments');
      expect(count.rows[0].n).toBe(0);
    });

    it("le même code de faculté est permis dans deux universités", async () => {
      await api()
        .post('/v1/faculties')
        .set('Host', tenants.b.host)
        .set('Authorization', `Bearer ${tenants.b.rectorToken}`)
        .send({ code: 'SCI', name: 'Sciences B' })
        .expect(201);
    });
  });

  describe('RLS au niveau de la base (rôle elongo_app)', () => {
    it('ne renvoie aucune ligne sans tenant fixé', async () => {
      const res = await h.appPool.query('SELECT count(*)::int AS n FROM faculties');
      expect(res.rows[0].n).toBe(0);
    });

    it("ne renvoie que les lignes du tenant fixé, même sans WHERE", async () => {
      const client = await h.appPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenants.a.id]);
        const res = await client.query<{ tenant_id: string }>('SELECT tenant_id FROM users');
        expect(res.rows.length).toBeGreaterThan(0);
        expect(new Set(res.rows.map((r) => r.tenant_id))).toEqual(new Set([tenants.a.id]));
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    });

    it("refuse d'écrire une ligne pour un autre tenant", async () => {
      const client = await h.appPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenants.a.id]);
        await expect(
          client.query(`INSERT INTO faculties (tenant_id, code, name) VALUES ($1, 'PIRATE', 'x')`, [tenants.b.id]),
        ).rejects.toThrow(/row-level security/);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it("le tenant fixé ne fuit pas d'une transaction à l'autre sur la même connexion", async () => {
      const client = await h.appPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenants.a.id]);
        await client.query('COMMIT');
        const res = await client.query('SELECT count(*)::int AS n FROM users');
        expect(res.rows[0].n).toBe(0);
      } finally {
        client.release();
      }
    });

    it('elongo_app ne contourne pas la RLS', async () => {
      const res = await h.admin.query(`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'elongo_app'`);
      expect(res.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    });

    it("le portail plateforme ne lit pas les utilisateurs d'une université", async () => {
      const platform = new (require('pg').Pool)({ connectionString: h.env.PLATFORM_DATABASE_URL });
      try {
        const res = await platform.query('SELECT count(*)::int AS n FROM users');
        expect(res.rows[0].n).toBe(0);
      } finally {
        await platform.end();
      }
    });

    it('le portail plateforme obtient des compteurs agrégés', async () => {
      const res = await api().get('/platform/tenants').set('Authorization', `Bearer ${platformToken}`).expect(200);
      const a = res.body.find((t: { slug: string }) => t.slug === 'unia');
      expect(a).toMatchObject({ usersTotal: 2, usersActive: 1, facultiesTotal: 1 });
      expect(a).not.toHaveProperty('email');
    });
  });
});
