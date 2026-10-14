import { useEffect, useState } from 'react';
import { useSession } from '@/session/session';
import { Body, Button, Notice, Screen, Title } from '@/ui/components';

/** L'app était fermée ou en arrière-plan : empreinte ou visage avant d'afficher les données. */
export default function Locked() {
  const { tenant, unlock, signOut } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tryUnlock = async () => {
    setBusy(true);
    setError(null);
    try {
      await unlock();
    } catch (err) {
      setError((err as Error).message || 'Déverrouillage impossible.');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void tryUnlock();
    // Une seule invite automatique à l'ouverture ; ensuite, le bouton.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Screen>
      <Title>{tenant?.name}</Title>
      <Body muted>Votre espace est verrouillé.</Body>
      {error && <Notice kind="error">{error}</Notice>}
      <Button title="Déverrouiller" onPress={tryUnlock} busy={busy} />
      <Button title="Se déconnecter" variant="outline" onPress={() => void signOut()} disabled={busy} />
    </Screen>
  );
}
