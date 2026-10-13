import request from 'supertest';
import { createHarness, Harness } from './harness';

describe("Contenu de la page d'accueil", () => {
  let h: Harness;
  const hosts = { a: 'unig.elongo.test', b: 'unih.elongo.test' };
  const rector: Record<'a' | 'b', string> = { a: '', b: '' };
  let studentToken: string;

  const api = () => request(h.app.getHttpServer());

  beforeAll(async () => {
    h = await createHarness();
    const platformToken = await h.token('elongo-platform', { sub: 'ops', realm_access: { roles: ['platform-admin'] } });
    for (const [key, slug] of [['a', 'unig'], ['b', 'unih']] as const) {
      const res = await api()
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${platformToken}`)
        .send({ slug, name: slug, rector: { email: `recteur@${slug}.cd`, fullName: 'Recteur' } })
        .expect(201);
      rector[key] = await h.token(res.body.keycloakRealm, { sub: `r-${slug}`, email: `recteur@${slug}.cd`, email_verified: true });
      if (key === 'a') {
        const user = await h.admin.query<{ id: string }>(
          `INSERT INTO users (tenant_id, email, full_name, external_id, status) VALUES ($1, 'e@unig.cd', 'Étudiant', 'e-unig', 'active') RETURNING id`,
          [res.body.id],
        );
        await h.admin.query(
          `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type)
           SELECT $1, $2, id, 'university' FROM roles WHERE tenant_id = $1 AND key = 'student'`,
          [res.body.id, user.rows[0].id],
        );
        studentToken = await h.token(res.body.keycloakRealm, { sub: 'e-unig' });
      }
    }

    const post = (body: object) =>
      api().post('/v1/announcements').set('Host', hosts.a).set('Authorization', `Bearer ${rector.a}`).send(body).expect(201);
    await post({ title: 'Rentrée académique', body: 'Le 3 novembre.', visibility: 'public' });
    await post({ title: 'Réunion du conseil', body: 'Interne.', visibility: 'campus' });
    await post({ title: 'Annonce future', body: 'Pas encore.', visibility: 'public', publishedAt: '2099-01-01' });
    await api()
      .post('/v1/faculties')
      .set('Host', hosts.a)
      .set('Authorization', `Bearer ${rector.a}`)
      .send({ code: 'MED', name: 'Faculté de médecine' })
      .expect(201);
  });

  afterAll(async () => {
    await h?.close();
  });

  it("est public et ne montre que les annonces publiques déjà publiées", async () => {
    const res = await api().get('/v1/public/homepage').set('Host', hosts.a).expect(200);
    expect(res.body.announcements.map((a: { title: string }) => a.title)).toEqual(['Rentrée académique']);
    expect(res.body.faculties).toEqual([{ code: 'MED', name: 'Faculté de médecine' }]);
  });

  it("ne mélange pas les universités", async () => {
    const res = await api().get('/v1/public/homepage').set('Host', hosts.b).expect(200);
    expect(res.body).toEqual({ hero: {}, faculties: [], announcements: [] });
  });

  it('un étudiant connecté voit aussi les annonces campus, mais ne publie pas', async () => {
    const res = await api().get('/v1/announcements').set('Host', hosts.a).set('Authorization', `Bearer ${studentToken}`).expect(200);
    expect(res.body.map((a: { title: string }) => a.title)).toEqual(['Réunion du conseil', 'Rentrée académique']);
    await api()
      .post('/v1/announcements')
      .set('Host', hosts.a)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ title: 'x', body: 'y', visibility: 'public' })
      .expect(403);
  });
});
