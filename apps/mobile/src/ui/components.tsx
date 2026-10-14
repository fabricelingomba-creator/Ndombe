import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, TextInputProps, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSession } from '@/session/session';
import { useTheme } from './theme';

const dateTime = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

/** Page défilante avec tirer-pour-actualiser et bandeau hors ligne. */
export function Screen({
  children,
  onRefresh,
  refreshing = false,
  offlineSince = null,
}: {
  children: React.ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  offlineSince?: number | null;
}) {
  const t = useTheme();
  const { online } = useSession();
  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: t.bg }}>
      {(!online || offlineSince) && (
        <View accessibilityRole="alert" style={[styles.banner, { backgroundColor: t.warningBg }]}>
          <Text style={{ color: t.warning, fontSize: 13 }}>
            {offlineSince
              ? `Hors ligne : données du ${dateTime.format(new Date(offlineSince))}`
              : 'Hors ligne : les données affichées peuvent dater.'}
          </Text>
        </View>
      )}
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} /> : undefined}
      >
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function Card({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  const t = useTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: t.surface, borderColor: t.line },
        accent ? { borderLeftWidth: 4, borderLeftColor: t.primary } : null,
      ]}
    >
      {children}
    </View>
  );
}

export function Title({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return (
    <Text accessibilityRole="header" style={[styles.title, { color: t.ink }]}>
      {children}
    </Text>
  );
}

export function Heading({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return (
    <Text accessibilityRole="header" style={[styles.heading, { color: t.ink }]}>
      {children}
    </Text>
  );
}

export function Body({ children, muted, bold }: { children: React.ReactNode; muted?: boolean; bold?: boolean }) {
  const t = useTheme();
  return <Text style={{ color: muted ? t.muted : t.ink, fontSize: 15, lineHeight: 21, fontWeight: bold ? '600' : '400' }}>{children}</Text>;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  busy = false,
  disabled = false,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'outline' | 'danger';
  busy?: boolean;
  disabled?: boolean;
}) {
  const t = useTheme();
  const primary = variant === 'primary';
  const color = primary ? t.onPrimary : variant === 'danger' ? t.danger : t.primary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary
          ? { backgroundColor: t.primary, borderColor: t.primary }
          : { backgroundColor: 'transparent', borderColor: variant === 'danger' ? t.danger : t.primary },
        (disabled || busy) && { opacity: 0.5 },
        pressed && { opacity: 0.8 },
      ]}
    >
      {busy ? <ActivityIndicator color={color} /> : <Text style={{ color, fontWeight: '600', fontSize: 16 }}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, hint, ...input }: TextInputProps & { label: string; hint?: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: t.ink, fontWeight: '600', fontSize: 14 }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={t.muted}
        style={[styles.input, { color: t.ink, borderColor: t.line, backgroundColor: t.surface }]}
        {...input}
      />
      {hint && <Text style={{ color: t.muted, fontSize: 13 }}>{hint}</Text>}
    </View>
  );
}

export function Notice({ kind, children }: { kind: 'error' | 'success' | 'warning'; children: React.ReactNode }) {
  const t = useTheme();
  const [fg, bg] = kind === 'error' ? [t.danger, t.dangerBg] : kind === 'success' ? [t.success, t.successBg] : [t.warning, t.warningBg];
  return (
    <View accessibilityRole={kind === 'error' ? 'alert' : undefined} style={[styles.notice, { backgroundColor: bg }]}>
      <Text style={{ color: fg, fontSize: 14, lineHeight: 20 }}>{children}</Text>
    </View>
  );
}

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'success' | 'warning' | 'danger' }) {
  const t = useTheme();
  const [fg, bg] =
    tone === 'success' ? [t.success, t.successBg] : tone === 'warning' ? [t.warning, t.warningBg] : tone === 'danger' ? [t.danger, t.dangerBg] : [t.muted, t.bg];
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={{ color: fg, fontSize: 12, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}

export function Loading() {
  const t = useTheme();
  return <ActivityIndicator style={{ marginTop: 32 }} color={t.primary} accessibilityLabel="Chargement" />;
}

export function Row({ children }: { children: React.ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

const styles = StyleSheet.create({
  banner: { paddingHorizontal: 16, paddingVertical: 8 },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 6 },
  title: { fontSize: 24, fontWeight: '700' },
  heading: { fontSize: 18, fontWeight: '700', marginTop: 8 },
  button: { minHeight: 48, borderRadius: 10, borderWidth: 2, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  input: { minHeight: 48, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, fontSize: 16 },
  notice: { borderRadius: 10, padding: 12 },
  badge: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
});
