import { useState } from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { useSession } from '@/session/session';
import { Body, Button, Field, Notice, Screen, Title } from '@/ui/components';

/** Premier lancement : l'étudiant indique son université (code ou adresse du portail). */
export default function ChooseUniversity() {
  const { chooseTenant } = useSession();
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await chooseTenant(input);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen>
        <Title>Bienvenue sur Elongo</Title>
        <Body muted>Indiquez le code de votre université ou l’adresse de son portail, par exemple « unikin » ou « portail.unikin.ac.cd ».</Body>
        <Field
          label="Université"
          value={input}
          onChangeText={setInput}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          keyboardType={Platform.OS === 'ios' ? 'url' : 'default'}
          returnKeyType="go"
          onSubmitEditing={submit}
          placeholder="unikin"
        />
        {error && <Notice kind="error">{error}</Notice>}
        <Button title="Continuer" onPress={submit} busy={busy} disabled={!input.trim()} />
      </Screen>
    </KeyboardAvoidingView>
  );
}
