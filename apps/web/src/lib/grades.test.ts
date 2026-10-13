import { describe, expect, it } from 'vitest';
import { formatScore, parseScore } from './grades';

describe('saisie des notes', () => {
  it('accepte la virgule et le point décimal', () => {
    expect(parseScore('12,5')).toBe(12.5);
    expect(parseScore(' 14.75 ')).toBe(14.75);
    expect(parseScore('0')).toBe(0);
    expect(parseScore('20')).toBe(20);
  });

  it('un champ vide efface la note', () => {
    expect(parseScore('')).toBeNull();
    expect(parseScore('   ')).toBeNull();
  });

  it('refuse ce qui sort du barème ou n’est pas une note', () => {
    for (const raw of ['21', '20,01', '-1', 'abc', '12,345', '1e1', '12,5,1']) {
      expect(parseScore(raw)).toBeUndefined();
    }
  });

  it('affiche à la française et réaffiche ce qui a été saisi', () => {
    expect(formatScore(12.5)).toBe('12,5');
    expect(formatScore(null)).toBe('—');
    expect(parseScore(formatScore(14.75))).toBe(14.75);
  });
});
