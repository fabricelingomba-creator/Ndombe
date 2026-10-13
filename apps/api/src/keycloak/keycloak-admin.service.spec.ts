import { loadEnv } from '../config/env';
import { fakeKeycloak, KEYCLOAK_ADMIN_ENV } from '../../test/fake-keycloak';
import { buildRealm, KeycloakAdminError, KeycloakAdminService, MOBILE_REDIRECT_URI } from './keycloak-admin.service';

function service(kc: ReturnType<typeof fakeKeycloak>, withAdmin = true) {
  const env = loadEnv({
    DATABASE_URL: 'postgres://x@localhost/x',
    PLATFORM_DATABASE_URL: 'postgres://x@localhost/x',
    KEYCLOAK_URL: 'https://auth.elongo.test/',
    ...(withAdmin ? KEYCLOAK_ADMIN_ENV : {}),
  });
  return new KeycloakAdminService(env, kc.fetch);
}

const spec = { realm: 'univ-unikin', displayName: 'UNIKIN', domains: ['unikin.elongo.app'], locale: 'fr' };

describe('KeycloakAdminService', () => {
  it("est désactivé sans client d'administration", async () => {
    const kc = fakeKeycloak();
    const svc = service(kc, false);
    expect(svc.enabled).toBe(false);
    await expect(svc.ensureRealm(spec)).rejects.toThrow(KeycloakAdminError);
    expect(kc.calls).toHaveLength(0);
  });

  it('crée le realm puis le considère existant au second appel', async () => {
    const kc = fakeKeycloak();
    const svc = service(kc);
    await expect(svc.ensureRealm(spec)).resolves.toBe('created');
    await expect(svc.ensureRealm(spec)).resolves.toBe('exists');
    expect(kc.realms).toEqual(new Set(['univ-unikin']));
  });

  it('réutilise le jeton administrateur tant qu’il est valide', async () => {
    const kc = fakeKeycloak();
    const svc = service(kc);
    await svc.ensureRealm(spec);
    await svc.ensureRealm({ ...spec, realm: 'univ-upn' });
    expect(kc.tokensIssued).toBe(1);
  });

  it('invite un administrateur avec MFA obligatoire et envoie l’e-mail', async () => {
    const kc = fakeKeycloak();
    const svc = service(kc);
    await svc.ensureRealm(spec);
    const res = await svc.inviteUser('univ-unikin', { email: 'recteur@unikin.ac.cd', fullName: 'Jean Mbala Kasa', requireMfa: true });
    expect(res).toEqual({ userId: 'kc-1', emailSent: true });
    const created = kc.calls.find((c) => c.method === 'POST' && c.path.endsWith('/users'))!;
    expect(created.body).toMatchObject({
      username: 'recteur@unikin.ac.cd',
      firstName: 'Jean',
      lastName: 'Mbala Kasa',
      emailVerified: false,
      requiredActions: ['VERIFY_EMAIL', 'UPDATE_PASSWORD', 'CONFIGURE_TOTP'],
    });
  });

  it("une invitation rejouée réutilise l'utilisateur existant", async () => {
    const kc = fakeKeycloak();
    const svc = service(kc);
    const u = { email: 'recteur@unikin.ac.cd', fullName: 'Recteur', requireMfa: true };
    const first = await svc.inviteUser('univ-unikin', u);
    const second = await svc.inviteUser('univ-unikin', u);
    expect(second.userId).toBe(first.userId);
    expect(kc.users.size).toBe(1);
  });

  it("signale un e-mail non envoyé sans échouer", async () => {
    const kc = fakeKeycloak({ smtp: false });
    const svc = service(kc);
    const res = await svc.inviteUser('univ-unikin', { email: 'a@b.cd', fullName: 'A B', requireMfa: false });
    expect(res.emailSent).toBe(false);
  });

  it('remonte une erreur Keycloak avec son statut', async () => {
    const kc = fakeKeycloak({ failOn: { 'POST /admin/realms': 500 } });
    await expect(service(kc).ensureRealm(spec)).rejects.toMatchObject({ status: 500 });
  });
});

describe('buildRealm', () => {
  const realm = buildRealm({ ...spec, domains: ['unikin.elongo.app', 'portail.unikin.ac.cd'] });

  it("n'autorise que les domaines de l'université et l'app mobile", () => {
    const portal = realm.clients.find((c) => c.clientId === 'elongo-portal')!;
    expect(portal.redirectUris).toEqual(['https://unikin.elongo.app/*', 'https://portail.unikin.ac.cd/*']);
    const mobile = realm.clients.find((c) => c.clientId === 'elongo-mobile')!;
    expect(mobile.redirectUris).toEqual([MOBILE_REDIRECT_URI]);
  });

  it('impose PKCE, interdit l’inscription libre et protège contre le bourrage', () => {
    expect(realm.registrationAllowed).toBe(false);
    expect(realm.bruteForceProtected).toBe(true);
    for (const c of realm.clients) {
      expect(c.publicClient).toBe(true);
      expect(c.directAccessGrantsEnabled).toBe(false);
      expect(c.attributes['pkce.code.challenge.method']).toBe('S256');
    }
  });
});
