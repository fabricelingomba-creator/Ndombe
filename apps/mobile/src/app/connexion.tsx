import { useState } from 'react';
import { Alert, Image, View } from 'react-native';
import { isNetworkFailure } from '@/lib/offline';
import { useSession } from '@/session/session';
import { Body, Button, Notice, Screen, Title } from '@/ui/components';

/** Connexion par la page sécurisée de l'université (SSO), jamais par un formulaire de l'app. */
export default function SignIn() {
  const { tenant, signIn, forgetTenant, biometrics, setBiometricsEnabled } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const ok = await signIn();
      if (ok && biometrics.available && !biometrics.enabled) {
        Alert.alert('Déverrouillage rapide', 'Utiliser votre empreinte ou votre visage pour rouvrir l’app ?', [
          { text: 'Plus tard', style: 'cancel' },
          { text: 'Activer', onPress: () => void setBiometricsEnabled(true) },
        ]);
      }
    } catch (err) {
      setError(isNetworkFailure(err) ? 'Pas de connexion internet.' : (err as Error).message || 'Connexion impossible.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={{ alignItems: 'center', gap: 12, marginTop: 24, marginBottom: 8 }}>
        {tenant?.logoUrl && (
          <Image source={{ uri: tenant.logoUrl }} style={{ width: 96, height: 96 }} resizeMode="contain" accessibilityLabel={`Logo ${tenant.name}`} />
        )}
        <Title>{tenant?.name}</Title>
      </View>
      <Body muted>Vous allez être dirigé vers la page de connexion de votre université. Votre mot de passe n’est jamais saisi dans l’app.</Body>
      {error && <Notice kind="error">{error}</Notice>}
      <Button title="Se connecter" onPress={start} busy={busy} />
      <Button title="Changer d’université" variant="outline" onPress={() => void forgetTenant()} disabled={busy} />
    </Screen>
  );
}
