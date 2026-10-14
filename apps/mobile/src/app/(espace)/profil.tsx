import type { NotificationCategory, NotificationPreference } from '@elongo/shared/types';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { Alert, Platform, Switch, Text, View } from 'react-native';
import { useSession } from '@/session/session';
import { useResource } from '@/session/use-resource';
import { Body, Button, Card, Heading, Notice, Row, Screen, Title } from '@/ui/components';
import { useTheme } from '@/ui/theme';

/** Pastille blanche sur la couleur de l'université (activeThumbColor : version web). */
const switchColors = (on: string, off: string) =>
  ({ trackColor: { true: on, false: off }, thumbColor: '#FFFFFF', activeThumbColor: '#FFFFFF' }) as object;

/** Compte, sécurité de l'app et choix des e-mails. */
export default function Profile() {
  const { me, tenant, biometrics, setBiometricsEnabled, signOut, forgetTenant, api } = useSession();
  const prefs = useResource<NotificationPreference[]>('notification-preferences', '/v1/me/notification-preferences');
  const [email, setEmail] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const t = useTheme();

  useEffect(() => {
    if (prefs.data) setEmail(Object.fromEntries(prefs.data.map((p) => [p.category, p.email])));
  }, [prefs.data]);

  const toggle = async (category: NotificationCategory, value: boolean) => {
    const next = { ...email, [category]: value };
    setEmail(next);
    setSaving(true);
    setResult(null);
    try {
      await api!.put('/v1/me/notification-preferences', { email: { [category]: value } });
    } catch (err) {
      setEmail(email);
      setResult({ kind: 'error', message: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const confirm = (title: string, message: string, action: () => Promise<void>) => {
    if (Platform.OS === 'web') {
      if (window.confirm(`${title}\n\n${message}`)) void action();
      return;
    }
    Alert.alert(title, message, [
      { text: 'Annuler', style: 'cancel' },
      { text: title, style: 'destructive', onPress: () => void action() },
    ]);
  };

  return (
    <Screen offlineSince={prefs.offlineSince}>
      <Title>{me?.fullName}</Title>
      <Body muted>{me?.email}</Body>
      <Body muted>{tenant?.name}</Body>

      {biometrics.available && (
        <Card>
          <Row>
            <View style={{ flexShrink: 1, gap: 2 }}>
              <Body bold>Déverrouillage biométrique</Body>
              <Body muted>Empreinte ou visage à l’ouverture de l’app.</Body>
            </View>
            <Switch
              accessibilityLabel="Déverrouillage biométrique"
              value={biometrics.enabled}
              onValueChange={(v) => void setBiometricsEnabled(v)}
              {...switchColors(t.primary, t.line)}
            />
          </Row>
        </Card>
      )}

      <Heading>Recevoir aussi par e-mail</Heading>
      <Body muted>Les notifications restent toujours visibles dans l’app ; ces choix ne concernent que les e-mails.</Body>
      <Card>
        {prefs.data?.map((p) => (
          <Row key={p.category}>
            <Text style={{ color: t.ink, fontSize: 15, flexShrink: 1 }}>{p.label}</Text>
            <Switch
              accessibilityLabel={`E-mails : ${p.label}`}
              value={email[p.category] ?? p.email}
              disabled={saving || prefs.offlineSince !== null}
              onValueChange={(v) => void toggle(p.category, v)}
              {...switchColors(t.primary, t.line)}
            />
          </Row>
        ))}
        {prefs.error && !prefs.data && <Notice kind="error">{prefs.error}</Notice>}
      </Card>
      {result && <Notice kind={result.kind}>{result.message}</Notice>}

      <Button title="Ouvrir le portail web" variant="outline" onPress={() => void WebBrowser.openBrowserAsync(`${tenant?.portalUrl}/espace`)} />
      <Button
        title="Changer d’université"
        variant="outline"
        onPress={() => confirm('Changer d’université', 'Vous serez déconnecté et les données gardées sur ce téléphone seront effacées.', forgetTenant)}
      />
      <Button
        title="Se déconnecter"
        variant="danger"
        onPress={() => confirm('Se déconnecter', 'Les données gardées sur ce téléphone seront effacées.', signOut)}
      />
    </Screen>
  );
}
