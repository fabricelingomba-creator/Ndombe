import { parseTenantInput } from '../tenant';

describe("Choix de l'université", () => {
  it('reconnaît un code, une adresse de portail ou un domaine personnalisé', () => {
    expect(parseTenantInput(' UniKin ')).toEqual({ kind: 'slug', slug: 'unikin' });
    expect(parseTenantInput('unikin.elongo.app')).toEqual({ kind: 'host', host: 'unikin.elongo.app' });
    expect(parseTenantInput('https://portail.unikin.cd/espace?x=1')).toEqual({ kind: 'host', host: 'portail.unikin.cd' });
    expect(parseTenantInput('portail.unikin.cd:443')).toEqual({ kind: 'host', host: 'portail.unikin.cd' });
  });

  it('refuse le reste', () => {
    for (const bad of ['', ' ', 'a', 'uni kin', 'javascript:alert(1)', '-unikin', 'unikin..cd', 'x'.repeat(70)]) {
      expect(parseTenantInput(bad)).toBeNull();
    }
  });
});
