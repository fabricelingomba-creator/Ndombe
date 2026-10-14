import { linkTarget } from '../links';

const portal = 'https://unikin.elongo.app';

describe('linkTarget', () => {
  it("ouvre l'écran de l'app quand il existe", () => {
    expect(linkTarget('/espace/paiements', portal)).toEqual({ kind: 'app', href: '/paiements' });
    expect(linkTarget('/espace/notes', portal)).toEqual({ kind: 'app', href: '/etudes' });
    expect(linkTarget('/espace', portal)).toEqual({ kind: 'app', href: '/' });
  });

  it('renvoie les tâches du personnel vers le portail web', () => {
    expect(linkTarget('/espace/validation-notes', portal)).toEqual({ kind: 'web', url: `${portal}/espace/validation-notes` });
    expect(linkTarget('/espace/notation/5b0c6a52-3f2c-4d8e-9a51-0a8f7f4c2b11', portal)).toEqual({
      kind: 'web',
      url: `${portal}/espace/notation/5b0c6a52-3f2c-4d8e-9a51-0a8f7f4c2b11`,
    });
  });

  it('refuse tout lien qui sortirait du portail', () => {
    expect(linkTarget('https://evil.example/espace', portal)).toBeNull();
    expect(linkTarget('//evil.example/espace', portal)).toBeNull();
    expect(linkTarget('/espace/../admin', portal)).toBeNull();
    expect(linkTarget('/espace/x?next=//evil', portal)).toBeNull();
    expect(linkTarget(null, portal)).toBeNull();
    expect(linkTarget('/espace/finances', 'javascript:alert(1)')).toBeNull();
  });
});
