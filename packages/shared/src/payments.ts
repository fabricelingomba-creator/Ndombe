import type { InvoiceStatus, PaymentStatus } from './types';

export const INVOICE_LABELS: Record<InvoiceStatus, string> = {
  open: 'À payer',
  paid: 'Payée',
  cancelled: 'Annulée',
};

export const PAYMENT_LABELS: Record<PaymentStatus, string> = {
  pending: 'En attente de confirmation',
  succeeded: 'Réussi',
  failed: 'Échoué',
};

/** 25050 USD → « 250,50 $US ». Les montants circulent en unités mineures (centimes). */
export function formatMoney(minor: number, currency: string, locale = 'fr'): string {
  return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'fr-FR', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(minor / 100);
}

/**
 * Lit un montant saisi au clavier : « 250 », « 250,50 » ou « 1 250.5 ».
 * Deux décimales au plus, strictement positif ; undefined sinon.
 */
export function parseAmount(raw: string): number | undefined {
  const text = raw.replace(/[\s  ]/g, '').replace(',', '.');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) return undefined;
  const value = Number(text);
  return value > 0 ? value : undefined;
}

/** Numéro Mobile Money : « 0812 345 678 » devient +243812345678 (RDC par défaut). */
export function normalizePhone(raw: string, defaultCountry = '243'): string | undefined {
  let digits = raw.replace(/[\s().-]/g, '');
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  if (!digits.startsWith('+')) digits = `+${defaultCountry}${digits.replace(/^0/, '')}`;
  if (!/^\+[1-9][0-9]{7,14}$/.test(digits)) return undefined;
  // RDC : indicatif suivi de 9 chiffres (81…, 82…, 97…, 99…).
  if (digits.startsWith('+243') && !/^\+243[0-9]{9}$/.test(digits)) return undefined;
  return digits;
}

/** Totaux par devise : jamais d'addition entre francs congolais et dollars. */
export function totalsByCurrency(items: { amountMinor: number; paidMinor: number; currency: string }[]) {
  const totals = new Map<string, { billed: number; paid: number }>();
  for (const i of items) {
    const t = totals.get(i.currency) ?? { billed: 0, paid: 0 };
    t.billed += i.amountMinor;
    t.paid += Math.min(i.paidMinor, i.amountMinor);
    totals.set(i.currency, t);
  }
  return [...totals.entries()].map(([currency, t]) => ({ currency, ...t, outstanding: t.billed - t.paid }));
}
