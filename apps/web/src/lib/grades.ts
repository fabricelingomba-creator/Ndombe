import type { GradesStatus } from './types';

export const STATUS_LABELS: Record<GradesStatus, string> = {
  draft: 'Brouillon',
  submitted: 'Soumise',
  returned: 'Renvoyée',
  approved: 'Approuvée',
  published: 'Publiée',
};

export const PASSING_SCORE = 10;

const scoreFormat = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });

export function formatScore(score: number | null): string {
  return score === null ? '—' : scoreFormat.format(score);
}

/**
 * Lit une note saisie au clavier : « 12,5 » ou « 12.5 », sur 20, au centième.
 * Champ vide : null (note effacée). Valeur invalide : undefined.
 */
export function parseScore(raw: string): number | null | undefined {
  const text = raw.trim().replace(',', '.');
  if (text === '') return null;
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(text)) return undefined;
  const value = Number(text);
  return value >= 0 && value <= 20 ? value : undefined;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
