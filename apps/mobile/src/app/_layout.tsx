import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider, useSession } from '@/session/session';

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <RootStack />
      </SessionProvider>
    </SafeAreaProvider>
  );
}

/**
 * Chaque état de session n'ouvre que ses écrans : sans université choisie on
 * ne voit que le choix de l'université, verrouillé on ne voit que le verrou.
 */
function RootStack() {
  const { status } = useSession();

  useEffect(() => {
    if (status !== 'loading') void SplashScreen.hideAsync().catch(() => undefined);
  }, [status]);

  if (status === 'loading') return null;

  return (
    <>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Protected guard={status === 'ready'}>
          <Stack.Screen name="(espace)" />
        </Stack.Protected>
        <Stack.Protected guard={status === 'no-tenant'}>
          <Stack.Screen name="universite" />
        </Stack.Protected>
        <Stack.Protected guard={status === 'signed-out'}>
          <Stack.Screen name="connexion" />
        </Stack.Protected>
        <Stack.Protected guard={status === 'locked'}>
          <Stack.Screen name="verrou" />
        </Stack.Protected>
        <Stack.Screen name="auth/callback" />
      </Stack>
    </>
  );
}
