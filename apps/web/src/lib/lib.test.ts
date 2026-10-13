import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { navFor } from './navigation';
import { codeChallenge, randomToken } from './pkce';
import { safeReturnTo } from './return-to';
import { seal, unseal } from './seal';
import { brandStyle, readableOn, safeImageUrl } from './theme';

const SECRET = 'x'.repeat(40);

describe('PKCE', () => {
  it('calcule le challenge S256 : base64url(SHA-256(verifier)), sans remplissage', async () => {
    const verifier = randomToken();
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(await codeChallenge(verifier)).toBe(expected);
    expect(expected).not.toContain('=');
  });

  it('génère des jetons aléatoires distincts', () => {
    expect(randomToken()).not.toBe(randomToken());
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('seal', () => {
  it('relit ce qu’il a chiffré', async () => {
    const token = await seal({ host: 'unikin.elongo.app', n: 1 }, SECRET, 60);
    expect(await unseal(token, SECRET)).toMatchObject({ host: 'unikin.elongo.app', n: 1 });
  });

  it('rejette une autre clé, un contenu altéré ou expiré', async () => {
    const token = await seal({ a: 1 }, SECRET, 60);
    expect(await unseal(token, 'y'.repeat(40))).toBeNull();
    expect(await unseal(token.slice(0, -4) + 'AAAA', SECRET)).toBeNull();
    expect(await unseal(await seal({ a: 1 }, SECRET, -1), SECRET)).toBeNull();
    expect(await unseal(undefined, SECRET)).toBeNull();
  });
});

describe('navFor', () => {
  it("montre à un étudiant ses seules entrées", () => {
    const nav = navFor(['self:courses:read', 'self:grades:read', 'announcements:read']);
    expect(nav.map((s) => s.key)).toEqual(['student']);
    expect(nav[0].items.map((i) => i.key)).toEqual(['courses', 'grades']);
  });

  it('montre la validation des notes au SG académique, pas les finances', () => {
    const nav = navFor(['grades:approve', 'grades:publish', 'academic:structure:write']);
    const items = nav.flatMap((s) => s.items.map((i) => i.key));
    expect(items).toContain('grade-approval');
    expect(items).not.toContain('finance');
  });

  it('montre les paiements à l’étudiant et les finances au SG administratif', () => {
    const student = navFor(['self:payments:write']).flatMap((s) => s.items);
    expect(student).toEqual([expect.objectContaining({ key: 'payments', href: '/espace/paiements' })]);
    expect(student[0].upcoming).toBeUndefined();
    const sga = navFor(['finance:read', 'fees:structures:write']).flatMap((s) => s.items.map((i) => i.key));
    expect(sga).toContain('finance');
  });

  it('ne montre rien sans permission', () => {
    expect(navFor([])).toEqual([]);
  });

  it("réserve les relevés officiels à une permission détenue sur toute l'université", () => {
    const keys = (grants: { permission: string; scope: { type: string; id: string | null } }[]) =>
      navFor(grants.map((g) => g.permission), grants).flatMap((s) => s.items.map((i) => i.key));
    expect(keys([{ permission: 'transcripts:validate', scope: { type: 'faculty', id: 'f1' } }])).not.toContain('transcripts');
    expect(keys([{ permission: 'transcripts:validate', scope: { type: 'university', id: null } }])).toContain('transcripts');
  });
});

describe('thème', () => {
  it('choisit un texte lisible sur la couleur de marque', () => {
    expect(readableOn('#0B5394')).toBe('#FFFFFF');
    expect(readableOn('#F1C232')).toBe('#000000');
  });

  it("n'injecte jamais une couleur invalide dans le CSS", () => {
    const style = brandStyle({
      primaryColor: 'red;} body{display:none',
      secondaryColor: '#123456',
      logoUrl: null,
      faviconUrl: null,
      hero: {},
    }) as Record<string, string>;
    expect(style['--brand-primary']).toBe('#1D4ED8');
    expect(style['--brand-secondary']).toBe('#123456');
  });

  it("n'accepte que des images https", () => {
    expect(safeImageUrl('https://cdn.unikin.ac.cd/logo.png')).toBe('https://cdn.unikin.ac.cd/logo.png');
    expect(safeImageUrl('javascript:alert(1)')).toBeNull();
    expect(safeImageUrl('http://evil.example/x.png')).toBeNull();
  });
});

describe('safeReturnTo', () => {
  it("refuse les redirections vers un autre site", () => {
    expect(safeReturnTo('/espace/notes')).toBe('/espace/notes');
    expect(safeReturnTo('//evil.example')).toBe('/espace');
    expect(safeReturnTo('/\\evil.example')).toBe('/espace');
    expect(safeReturnTo('https://evil.example')).toBe('/espace');
    expect(safeReturnTo(null)).toBe('/espace');
  });
});
