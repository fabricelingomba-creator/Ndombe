import { Stack } from 'expo-router';
import { useTheme } from '@/ui/theme';

export default function PaymentsLayout() {
  const t = useTheme();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: t.primary },
        headerTintColor: t.onPrimary,
        headerTitleStyle: { fontWeight: '700' },
        contentStyle: { backgroundColor: t.bg },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Paiements' }} />
      <Stack.Screen name="[invoiceId]" options={{ title: 'Facture', headerBackTitle: 'Paiements' }} />
    </Stack>
  );
}
