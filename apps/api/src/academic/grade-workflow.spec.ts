import { nextStatus, termResult } from './grade-workflow';

describe('Circuit des notes', () => {
  it('suit draft → submitted → approved → published', () => {
    expect(nextStatus('submit', 'draft')).toBe('submitted');
    expect(nextStatus('approve', 'submitted')).toBe('approved');
    expect(nextStatus('publish', 'approved')).toBe('published');
  });

  it('permet le renvoi puis une nouvelle soumission', () => {
    expect(nextStatus('return', 'submitted')).toBe('returned');
    expect(nextStatus('submit', 'returned')).toBe('submitted');
  });

  it('refuse les sauts et les retours en arrière', () => {
    expect(nextStatus('publish', 'submitted')).toBeNull();
    expect(nextStatus('approve', 'draft')).toBeNull();
    expect(nextStatus('submit', 'published')).toBeNull();
    expect(nextStatus('return', 'published')).toBeNull();
  });
});

describe('Résultats de période', () => {
  it('calcule la moyenne pondérée par les crédits et les crédits acquis', () => {
    expect(
      termResult('2026-S1', [
        { score: 14, credits: 5 },
        { score: 8, credits: 3 },
      ]),
    ).toEqual({ termCode: '2026-S1', average: 11.75, creditsAttempted: 8, creditsEarned: 5 });
  });

  it('valide un cours à 10/20 exactement', () => {
    expect(termResult('T', [{ score: 10, credits: 4 }]).creditsEarned).toBe(4);
  });

  it("n'invente pas de moyenne sans note", () => {
    expect(termResult('T', []).average).toBeNull();
  });
});
