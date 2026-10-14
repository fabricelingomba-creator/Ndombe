import { useColorScheme } from 'react-native';
import { useSession } from '@/session/session';

/** Texte lisible sur une couleur de marque (contraste WCAG). */
export function onColor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.4 ? '#111827' : '#FFFFFF';
}

export function useTheme() {
  const { tenant } = useSession();
  const dark = useColorScheme() === 'dark';
  const primary = tenant?.primaryColor ?? '#1D4ED8';
  return {
    dark,
    primary,
    onPrimary: onColor(primary),
    bg: dark ? '#0B1220' : '#F4F5F7',
    surface: dark ? '#111A2E' : '#FFFFFF',
    ink: dark ? '#E5E7EB' : '#111827',
    muted: dark ? '#9CA3AF' : '#4B5563',
    line: dark ? '#1F2A44' : '#E5E7EB',
    danger: dark ? '#FCA5A5' : '#B91C1C',
    dangerBg: dark ? '#3B1111' : '#FEF2F2',
    success: dark ? '#6EE7B7' : '#065F46',
    successBg: dark ? '#0B2E22' : '#ECFDF5',
    warning: dark ? '#FCD34D' : '#854D0E',
    warningBg: dark ? '#33280A' : '#FEFCE8',
  };
}

export type Theme = ReturnType<typeof useTheme>;
