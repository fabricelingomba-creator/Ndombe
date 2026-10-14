export const SLIP_MAX_BYTES = 5 * 1024 * 1024;

export type SlipType = 'application/pdf' | 'image/jpeg' | 'image/png';

/**
 * Type réel d'un bordereau, lu dans ses premiers octets : le type annoncé par
 * le navigateur n'est pas fiable. PDF, JPEG ou PNG uniquement.
 */
export function detectSlipType(file: Buffer): SlipType | null {
  if (file.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (file.length >= 3 && file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff) return 'image/jpeg';
  if (file.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

export const SLIP_EXTENSIONS: Record<SlipType, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/** Date de dépôt plausible : pas dans le futur (un jour de marge pour les fuseaux), pas plus d'un an avant. */
export function isPlausibleDepositDate(isoDate: string, now = new Date()): boolean {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== isoDate) return false;
  const day = 24 * 60 * 60 * 1000;
  return date.getTime() <= now.getTime() + day && date.getTime() >= now.getTime() - 366 * day;
}
