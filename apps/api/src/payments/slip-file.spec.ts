import { detectSlipType, isPlausibleDepositDate } from './slip-file';

describe('Bordereau', () => {
  it('reconnaît PDF, JPEG et PNG par leur contenu, pas par leur nom', () => {
    expect(detectSlipType(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
    expect(detectSlipType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe('image/jpeg');
    expect(detectSlipType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBe('image/png');
    expect(detectSlipType(Buffer.from('<svg onload="alert(1)">'))).toBeNull();
    expect(detectSlipType(Buffer.from('<html>'))).toBeNull();
    expect(detectSlipType(Buffer.alloc(0))).toBeNull();
  });

  it("n'accepte qu'une date de dépôt réelle, ni future ni vieille de plus d'un an", () => {
    const now = new Date('2026-10-14T08:00:00Z');
    expect(isPlausibleDepositDate('2026-10-14', now)).toBe(true);
    expect(isPlausibleDepositDate('2026-10-15', now)).toBe(true); // fuseau horaire
    expect(isPlausibleDepositDate('2026-10-17', now)).toBe(false);
    expect(isPlausibleDepositDate('2025-09-01', now)).toBe(false);
    expect(isPlausibleDepositDate('2026-02-30', now)).toBe(false);
    expect(isPlausibleDepositDate('14/10/2026', now)).toBe(false);
  });
});
