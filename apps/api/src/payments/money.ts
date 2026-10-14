export const CURRENCIES = ['CDF', 'USD'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** 12,50 USD → 1250. Refuse plus de deux décimales plutôt que d'arrondir. */
export function toMinor(amount: number): number | null {
  const minor = Math.round(amount * 100);
  if (!Number.isFinite(amount) || amount <= 0 || Math.abs(minor - amount * 100) > 1e-6) return null;
  return minor;
}

export function fromMinor(minor: number | string): number {
  return Number(minor) / 100;
}

/** 25050 USD → « 250,50 $US ». */
export function formatMoney(minor: number | string, currency: string): string {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency, minimumFractionDigits: 2 }).format(Number(minor) / 100);
}
