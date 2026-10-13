import type { CSSProperties } from 'react';
import type { Branding } from './types';

const HEX = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_PRIMARY = '#1D4ED8';
const DEFAULT_SECONDARY = '#F59E0B';

/** Texte lisible (noir ou blanc) sur une couleur de fond, selon sa luminance (WCAG). */
export function readableOn(hex: string): '#000000' | '#FFFFFF' {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  // Contraste contre le blanc vs contre le noir : on garde le plus élevé.
  return (1.05) / (luminance + 0.05) >= (luminance + 0.05) / 0.05 ? '#FFFFFF' : '#000000';
}

/**
 * Variables CSS de la marque d'une université. Les couleurs sont revalidées
 * ici : seule une valeur #RRGGBB atteint la feuille de style.
 */
export function brandStyle(branding: Branding | null): CSSProperties {
  const primary = branding?.primaryColor && HEX.test(branding.primaryColor) ? branding.primaryColor : DEFAULT_PRIMARY;
  const secondary = branding?.secondaryColor && HEX.test(branding.secondaryColor) ? branding.secondaryColor : DEFAULT_SECONDARY;
  return {
    '--brand-primary': primary,
    '--brand-on-primary': readableOn(primary),
    '--brand-secondary': secondary,
    '--brand-on-secondary': readableOn(secondary),
  } as CSSProperties;
}

/** N'accepte que les images en https (ou http en local), pour ne pas injecter d'URL arbitraire. */
export function safeImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname.endsWith('localhost')) ? u.toString() : null;
  } catch {
    return null;
  }
}
