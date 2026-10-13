import request from 'supertest';
import { fakeKeycloak, KEYCLOAK_ADMIN_ENV } from './fake-keycloak';
import { createHarness, Harness } from './harness';

describe('Onboarding avec Keycloak', () => {
  let h: Harness;
  let kc: ReturnType<typeof fakeKeycloak>;
  let platformToken: string;
  const failures: Record<string, number> = {};

  const api = () => request(h.app.getHttpServer());
  const provision = (slug: string) =>
    api()
      .post('/platform/tenants')
      .set('Authorization', `Bearer ${platformToken}`)
      .send({ slug, name: `Université ${slug}`, rector: { email: `recteur@${slug}.ac.cd`, fullName: 'Marie Kabila' } });

  beforeAll(async () => {
    kc = fakeKeycloak({ failOn: failures });
    h = await createHarness({ env: KEYCLOAK_ADMIN_ENV, keycloakFetch: kc.fetch });
    platformToken = await h.token('elongo-platform', { sub: 'ops', realm_access: { roles: ['platform-admin'] } });
  });

  afterAll(async () => {
    await h?.close();
  });

  afterEach(() => {
    for (const k of Object.keys(failures)) delete failures[k];
  });

  it('crée le realm et invite le Recteur avec MFA', async () => {
    const res = await provision('unid').expect(201);
    expect(res.body.keycloak).toEqual({ realm: 'created', rectorInvitation: { emailSent: true } });
    expect(kc.realms.has('univ-unid')).toBe(true);
    expect(kc.users.get('univ-unid:recteur@unid.ac.cd')?.requiredActions).toContain('CONFIGURE_TOTP');
  });

  it("n'écrit rien en base si Keycloak refuse le realm", async () => {
    failures['POST /admin/realms'] = 500;
    await provision('unie').expect(500);
    const res = await h.admin.query(`SELECT count(*)::int AS n FROM tenants WHERE slug = 'unie'`);
    expect(res.rows[0].n).toBe(0);
  });

  it("garde l'université si l'invitation échoue, et la synchronisation la rejoue", async () => {
    failures['POST /admin/realms/univ-unif/users'] = 503;
    const res = await provision('unif').expect(201);
    expect(res.body.keycloak.realm).toBe('created');
    expect(res.body.keycloak.rectorInvitation.error).toMatch(/503/);

    delete failures['POST /admin/realms/univ-unif/users'];

    const sync = await api()
      .post('/platform/tenants/unif/keycloak/sync')
      .set('Authorization', `Bearer ${platformToken}`)
      .expect(200);
    expect(sync.body).toEqual({ realm: 'exists', rectorInvitation: { emailSent: true } });
    expect(kc.users.has('univ-unif:recteur@unif.ac.cd')).toBe(true);
  });

  it('la synchronisation renvoie 404 pour une université inconnue', async () => {
    await api().post('/platform/tenants/inconnue/keycloak/sync').set('Authorization', `Bearer ${platformToken}`).expect(404);
  });
});
