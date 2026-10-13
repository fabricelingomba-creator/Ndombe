import { buildSnapshot, newVerificationCode, normalizeVerificationCode, snapshotHash } from './transcript';
import { renderTranscriptPdf } from './transcript-pdf';

const sample = () =>
  buildSnapshot({
    university: { name: 'Université T', slug: 'unit' },
    student: { id: 's1', fullName: 'Étudiante Test', email: 'e@unit.cd' },
    terms: [
      {
        termCode: '2026-S1',
        termName: 'Semestre 1',
        average: 11.75,
        creditsAttempted: 8,
        creditsEarned: 5,
        grades: [
          { courseCode: 'A', courseTitle: 'Cours A', credits: 5, score: 14, publishedAt: new Date() },
          { courseCode: 'B', courseTitle: 'Cours B', credits: 3, score: 8, publishedAt: new Date() },
        ],
      },
    ],
    issuedAt: new Date('2026-10-13T12:00:00Z'),
    verificationCode: '7K2M-9QXA-4TPD',
    verifyUrl: 'https://unit.elongo.app/verifier',
  });

describe('Codes de vérification', () => {
  it('produit des codes au format attendu, sans caractères ambigus', () => {
    for (let i = 0; i < 200; i++) {
      expect(newVerificationCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    }
  });

  it('tolère la saisie manuelle', () => {
    expect(normalizeVerificationCode(' 7k2m 9qxa 4tpd ')).toBe('7K2M-9QXA-4TPD');
    expect(normalizeVerificationCode('7K2M-9QXA-4TPO')).toBe('7K2M-9QXA-4TP0');
    expect(normalizeVerificationCode('trop-court')).toBeNull();
    expect(normalizeVerificationCode("'; DROP TABLE x; --")).toBeNull();
  });
});

describe('Contenu figé du relevé', () => {
  it('calcule le bilan cumulé et ne garde que les champs imprimés', () => {
    const s = sample();
    expect(s.summary).toEqual({ average: 11.75, creditsAttempted: 8, creditsEarned: 5 });
    expect(s.terms[0].grades[0]).toEqual({ courseCode: 'A', courseTitle: 'Cours A', credits: 5, score: 14 });
  });

  it("l'empreinte change dès qu'une note change", () => {
    const a = sample();
    const b = sample();
    expect(snapshotHash(a)).toBe(snapshotHash(b));
    b.terms[0].grades[1].score = 18;
    expect(snapshotHash(a)).not.toBe(snapshotHash(b));
  });

  it('se rend en PDF', async () => {
    const pdf = await renderTranscriptPdf(sample(), { primaryColor: '#0B5394', contentHash: 'abc' });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
