import type { BankAccount, MyInvoice, Payment, PaymentOption } from '@elongo/shared/types';
import { blockingPayment, formatMoney, INVOICE_LABELS, normalizePhone, PAYMENT_LABELS, parseAmount } from '@elongo/shared/payments';
import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, Pressable, Text, View } from 'react-native';
import { appendFile, PickedFile } from '@/lib/upload';
import { useSession } from '@/session/session';
import { useResource } from '@/session/use-resource';
import { Badge, Body, Button, Card, Field, Heading, Loading, Notice, Row, Screen } from '@/ui/components';
import { formatDateTime, formatDay, today } from '@/ui/format';
import { useTheme } from '@/ui/theme';

const SLIP_MAX_BYTES = 5 * 1024 * 1024;
const SLIP_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

type Result = { kind: 'success' | 'error'; message: string } | null;

/** Une facture : son détail, ses paiements, et les deux façons de payer. */
export default function InvoiceScreen() {
  const { invoiceId } = useLocalSearchParams<{ invoiceId: string }>();
  const invoices = useResource<MyInvoice[]>('invoices', '/v1/me/invoices');
  const options = useResource<PaymentOption[]>('payment-options', '/v1/me/payment-options');
  const accounts = useResource<BankAccount[]>('bank-accounts', '/v1/me/bank-accounts');
  const invoice = invoices.data?.find((i) => i.id === invoiceId);
  const [method, setMethod] = useState<'mobile' | 'bank' | null>(null);
  const { online } = useSession();

  if (!invoices.data) {
    return <Screen>{invoices.error ? <Notice kind="error">{invoices.error}</Notice> : <Loading />}</Screen>;
  }
  if (!invoice) {
    return (
      <Screen>
        <Notice kind="error">Facture introuvable.</Notice>
      </Screen>
    );
  }

  const balance = invoice.amountMinor - invoice.paidMinor;
  const pending = blockingPayment(invoice.payments);
  const lastSlip = invoice.payments.find((p) => p.provider === 'bank');
  const rejected = lastSlip?.status === 'failed' ? lastSlip : null;
  const mobile = options.data?.find((o) => o.provider !== 'bank');
  const bankAccounts = (accounts.data ?? []).filter((a) => a.currency === invoice.currency);
  const bank = bankAccounts.length > 0;
  const reload = () => void invoices.reload();
  // Un paiement exige le réseau : jamais de formulaire sur une copie hors ligne.
  const connected = online && invoices.offlineSince === null;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <Stack.Screen options={{ title: invoice.feeName }} />
      <Screen refreshing={invoices.loading} onRefresh={reload} offlineSince={invoices.offlineSince}>
        <Card accent={invoice.status === 'open'}>
          <Row>
            <Body bold>{invoice.feeName}</Body>
            <Badge label={INVOICE_LABELS[invoice.status]} tone={invoice.status === 'paid' ? 'success' : 'neutral'} />
          </Row>
          <Body>Montant : {formatMoney(invoice.amountMinor, invoice.currency)}</Body>
          {invoice.paidMinor > 0 && <Body>Déjà payé : {formatMoney(invoice.paidMinor, invoice.currency)}</Body>}
          {invoice.status === 'open' && <Body bold>Reste à payer : {formatMoney(balance, invoice.currency)}</Body>}
          <Body muted>Échéance : {formatDay(invoice.dueOn)}</Body>
        </Card>

        {invoice.status === 'open' && pending && (
          <Notice kind="warning">
            {pending.provider === 'bank'
              ? 'Votre bordereau est en cours de vérification par le service financier. Vous serez notifié de la décision.'
              : 'Un paiement est en attente de confirmation sur votre téléphone.'}
          </Notice>
        )}

        {invoice.status === 'open' && !pending && rejected && (
          <Notice kind="error">
            Votre bordereau {rejected.slipReference} a été refusé : {rejected.failureReason}. Vous pouvez en envoyer un nouveau.
          </Notice>
        )}

        {invoice.status === 'open' && !pending && connected && (
          <>
            <Heading>Payer</Heading>
            {options.data && accounts.data && !mobile && !bank && <Body muted>Aucun moyen de paiement n’est encore ouvert par l’université.</Body>}
            <View style={{ gap: 8 }}>
              {mobile && <Choice label={mobile.label} selected={method === 'mobile'} onPress={() => setMethod('mobile')} />}
              {bank && <Choice label="Dépôt bancaire (bordereau)" selected={method === 'bank'} onPress={() => setMethod('bank')} />}
            </View>
            {method === 'mobile' && mobile && <MobileMoneyForm invoice={invoice} option={mobile} onDone={reload} />}
            {method === 'bank' && <BankSlipForm invoice={invoice} accounts={bankAccounts} onDone={reload} />}
          </>
        )}
        {invoice.status === 'open' && !connected && <Notice kind="warning">Le paiement demande une connexion internet.</Notice>}

        {invoice.payments.length > 0 && <Heading>Paiements</Heading>}
        {invoice.payments.map((p) => (
          <PaymentCard key={p.id} payment={p} onChange={reload} />
        ))}
      </Screen>
    </KeyboardAvoidingView>
  );
}

function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        borderWidth: 2,
        borderColor: selected ? t.primary : t.line,
        backgroundColor: t.surface,
        borderRadius: 10,
        padding: 14,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          borderWidth: 2,
          borderColor: selected ? t.primary : t.muted,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {selected && <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: t.primary }} />}
      </View>
      <Text style={{ color: t.ink, fontSize: 16, flexShrink: 1 }}>{label}</Text>
    </Pressable>
  );
}

/**
 * Mobile Money. La clé d'idempotence est tirée une fois par formulaire : un
 * double appui ou une coupure réseau renvoie le même paiement, jamais deux.
 */
function MobileMoneyForm({ invoice, option, onDone }: { invoice: MyInvoice; option: PaymentOption; onDone: () => void }) {
  const { api, tenant } = useSession();
  const [phone, setPhone] = useState('');
  const [key, setKey] = useState(() => Crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);

  const pay = async () => {
    setResult(null);
    const normalized = option.requiresPhone ? normalizePhone(phone) : undefined;
    if (option.requiresPhone && !normalized) {
      setResult({ kind: 'error', message: 'Numéro Mobile Money invalide, par exemple 0812 345 678 ou +243812345678.' });
      return;
    }
    setBusy(true);
    try {
      const res = await api!.post<{ status: string; redirectUrl: string | null; instructions?: string }>(
        `/v1/me/invoices/${invoice.id}/payments`,
        { provider: option.provider, phone: normalized, returnUrl: `${tenant!.portalUrl}/espace/paiements` },
        { 'idempotency-key': key },
      );
      if (res.redirectUrl && res.status === 'pending') await WebBrowser.openBrowserAsync(res.redirectUrl);
      setResult({ kind: 'success', message: res.instructions ?? 'Paiement lancé. Confirmez-le sur votre téléphone.' });
      setKey(Crypto.randomUUID());
      onDone();
    } catch (err) {
      setResult({ kind: 'error', message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      {option.requiresPhone && (
        <Field
          label="Numéro Mobile Money"
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          autoComplete="tel"
          textContentType="telephoneNumber"
          placeholder="0812 345 678"
          hint="M-Pesa, Orange Money ou Airtel Money"
        />
      )}
      {result && <Notice kind={result.kind}>{result.message}</Notice>}
      <Button title={`Payer ${formatMoney(invoice.amountMinor - invoice.paidMinor, invoice.currency)}`} onPress={pay} busy={busy} />
    </Card>
  );
}

/** Dépôt à la banque : l'étudiant photographie ou joint son bordereau ; le service financier le valide. */
function BankSlipForm({ invoice, accounts: usable, onDone }: { invoice: MyInvoice; accounts: BankAccount[]; onDone: () => void }) {
  const { api } = useSession();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(today());
  const [amount, setAmount] = useState(String((invoice.amountMinor - invoice.paidMinor) / 100));
  const [slip, setSlip] = useState<PickedFile | null>(null);
  const [key, setKey] = useState(() => Crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);
  const t = useTheme();

  const selected = accountId ?? (usable.length === 1 ? usable[0].id : null);

  const accept = (file: PickedFile) => {
    if (!SLIP_TYPES.includes(file.mimeType)) return setResult({ kind: 'error', message: 'Envoyez une photo (JPEG, PNG) ou un PDF.' });
    if (file.size !== null && file.size > SLIP_MAX_BYTES) return setResult({ kind: 'error', message: 'Fichier trop lourd (5 Mo au plus).' });
    setResult(null);
    setSlip(file);
  };

  const fromImage = (asset: ImagePicker.ImagePickerAsset) =>
    accept({
      uri: asset.uri,
      name: asset.fileName ?? `bordereau.${asset.mimeType === 'image/png' ? 'png' : 'jpg'}`,
      mimeType: asset.mimeType ?? 'image/jpeg',
      size: asset.fileSize ?? null,
    });

  const takePhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setResult({ kind: 'error', message: 'Autorisez l’appareil photo dans les réglages, ou choisissez une photo existante.' });
      return;
    }
    const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.7 });
    if (!r.canceled) fromImage(r.assets[0]);
  };

  const pickPhoto = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
    if (!r.canceled) fromImage(r.assets[0]);
  };

  const pickPdf = async () => {
    const r = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true });
    if (!r.canceled) {
      const a = r.assets[0];
      accept({ uri: a.uri, name: a.name, mimeType: a.mimeType ?? 'application/pdf', size: a.size ?? null });
    }
  };

  const submit = async () => {
    setResult(null);
    const value = parseAmount(amount);
    if (!selected) return setResult({ kind: 'error', message: 'Choisissez le compte sur lequel vous avez déposé.' });
    if (!/^[A-Za-z0-9][A-Za-z0-9/._-]{2,63}$/.test(reference.trim())) {
      return setResult({ kind: 'error', message: 'Numéro de bordereau invalide (lettres, chiffres, / . _ -).' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || paidOn > today()) return setResult({ kind: 'error', message: 'Date de dépôt invalide (AAAA-MM-JJ).' });
    if (value === undefined) return setResult({ kind: 'error', message: 'Montant invalide.' });
    if (!slip) return setResult({ kind: 'error', message: 'Joignez la photo ou le PDF du bordereau.' });
    setBusy(true);
    try {
      const form = new FormData();
      form.append('bankAccountId', selected);
      form.append('reference', reference.trim());
      form.append('paidOn', paidOn);
      form.append('amount', String(value));
      await appendFile(form, 'slip', slip);
      await api!.postForm(`/v1/me/invoices/${invoice.id}/bank-payments`, form, { 'idempotency-key': key });
      setResult({ kind: 'success', message: 'Bordereau envoyé. Le service financier va le vérifier.' });
      setSlip(null);
      setReference('');
      setKey(Crypto.randomUUID());
      onDone();
    } catch (err) {
      setResult({ kind: 'error', message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Body bold>1. Déposez le montant sur l’un de ces comptes</Body>
      {usable.map((a) => (
        <Choice
          key={a.id}
          selected={selected === a.id}
          onPress={() => setAccountId(a.id)}
          label={`${a.bankName}\n${a.accountName}\n${a.accountNumber}`}
        />
      ))}
      <Body bold>2. Renseignez le bordereau</Body>
      <Field label="Numéro du bordereau" value={reference} onChangeText={setReference} autoCapitalize="characters" autoCorrect={false} />
      <Field label="Date du dépôt" value={paidOn} onChangeText={setPaidOn} placeholder="AAAA-MM-JJ" keyboardType="numbers-and-punctuation" />
      <Field label={`Montant déposé (${invoice.currency})`} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
      <Body bold>3. Joignez le bordereau</Body>
      <View style={{ gap: 8 }}>
        {Platform.OS !== 'web' && <Button title="Prendre une photo" variant="outline" onPress={() => void takePhoto()} />}
        <Button title="Choisir une photo" variant="outline" onPress={() => void pickPhoto()} />
        <Button title="Choisir un PDF" variant="outline" onPress={() => void pickPdf()} />
      </View>
      {slip && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 8, borderRadius: 8, backgroundColor: t.bg }}>
          {slip.mimeType.startsWith('image/') ? (
            <Image source={{ uri: slip.uri }} style={{ width: 56, height: 56, borderRadius: 6 }} accessibilityLabel="Aperçu du bordereau" />
          ) : (
            <Badge label="PDF" />
          )}
          <Text style={{ color: t.ink, flexShrink: 1 }} numberOfLines={2}>
            {slip.name}
          </Text>
        </View>
      )}
      {result && <Notice kind={result.kind}>{result.message}</Notice>}
      <Button title="Envoyer le bordereau" onPress={() => void submit()} busy={busy} />
    </Card>
  );
}

function PaymentCard({ payment: p, onChange }: { payment: Payment; onChange: () => void }) {
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const simulate = async (outcome: 'succeeded' | 'failed') => {
    setBusy(true);
    setError(null);
    try {
      await api!.post(`/v1/me/payments/${p.id}/sandbox-confirm`, { outcome });
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Row>
        <Body bold>{formatMoney(p.amountMinor, p.currency)}</Body>
        <Badge label={p.provider === 'bank' && p.status === 'failed' ? 'Refusé' : PAYMENT_LABELS[p.status]} tone={p.status === 'succeeded' ? 'success' : p.status === 'failed' ? 'danger' : 'warning'} />
      </Row>
      <Body muted>
        {p.provider === 'bank' ? `Bordereau ${p.slipReference ?? ''}${p.bankName ? ` · ${p.bankName}` : ''}` : 'Mobile Money'} ·{' '}
        {formatDateTime(p.createdAt)}
      </Body>
      {p.failureReason && <Body>Motif : {p.failureReason}</Body>}
      {p.provider === 'sandbox' && p.status === 'pending' && (
        <>
          <Body muted>Démonstration : simulez la réponse du téléphone.</Body>
          <Row>
            <Button title="Confirmer" onPress={() => void simulate('succeeded')} busy={busy} />
            <Button title="Refuser" variant="danger" onPress={() => void simulate('failed')} disabled={busy} />
          </Row>
        </>
      )}
      {error && <Notice kind="error">{error}</Notice>}
    </Card>
  );
}
