import { describe, expect, it } from 'vitest';
import { formatMoney, normalizePhone, parseAmount, totalsByCurrency } from './payments';

const plain = (s: string) => s.replace(/[  ]/g, ' ');

describe('montants', () => {
  it('affiche les unités mineures dans la devise', () => {
    expect(plain(formatMoney(25050, 'USD'))).toBe('250,50 $US');
    expect(plain(formatMoney(1500000, 'CDF'))).toBe('15 000,00 CDF');
    expect(formatMoney(25050, 'USD', 'en')).toBe('$250.50');
  });

  it('lit une saisie française ou anglaise, deux décimales au plus', () => {
    expect(parseAmount('250')).toBe(250);
    expect(parseAmount('250,5')).toBe(250.5);
    expect(parseAmount('1 250.50')).toBe(1250.5);
    expect(parseAmount('12,345')).toBeUndefined();
    expect(parseAmount('0')).toBeUndefined();
    expect(parseAmount('-3')).toBeUndefined();
    expect(parseAmount('abc')).toBeUndefined();
  });

  it("totalise par devise, sans jamais additionner francs et dollars", () => {
    const totals = totalsByCurrency([
      { amountMinor: 25000, paidMinor: 25000, currency: 'USD' },
      { amountMinor: 25000, paidMinor: 0, currency: 'USD' },
      { amountMinor: 100000, paidMinor: 40000, currency: 'CDF' },
    ]);
    expect(totals).toEqual([
      { currency: 'USD', billed: 50000, paid: 25000, outstanding: 25000 },
      { currency: 'CDF', billed: 100000, paid: 40000, outstanding: 60000 },
    ]);
  });
});

describe('numéro Mobile Money', () => {
  it('complète un numéro local avec l’indicatif de la RDC', () => {
    expect(normalizePhone('0812 345 678')).toBe('+243812345678');
    expect(normalizePhone('812345678')).toBe('+243812345678');
    expect(normalizePhone('+243 81 234 5678')).toBe('+243812345678');
    expect(normalizePhone('00243812345678')).toBe('+243812345678');
    expect(normalizePhone('+225 07 08 09 10 11')).toBe('+2250708091011');
  });

  it('refuse ce qui ne ressemble pas à un numéro', () => {
    expect(normalizePhone('')).toBeUndefined();
    expect(normalizePhone('abc')).toBeUndefined();
    expect(normalizePhone('+0123')).toBeUndefined();
    // Un chiffre de trop ou de moins pour la RDC.
    expect(normalizePhone('0812 345 67')).toBeUndefined();
    expect(normalizePhone('+243 812 345 6789')).toBeUndefined();
  });
});
