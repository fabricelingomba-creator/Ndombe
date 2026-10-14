import type { MyInvoice } from '@elongo/shared/types';
import { formatMoney, INVOICE_LABELS, totalsByCurrency } from '@elongo/shared/payments';
import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { Pressable } from 'react-native';
import { useResource } from '@/session/use-resource';
import { Badge, Body, Card, Heading, Loading, Notice, Row, Screen } from '@/ui/components';
import { formatDay } from '@/ui/format';

/** Factures de l'étudiant : à payer d'abord, puis l'historique. */
export default function Invoices() {
  const invoices = useResource<MyInvoice[]>('invoices', '/v1/me/invoices');
  const { reload } = invoices;
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  const list = invoices.data ?? [];
  const open = list.filter((i) => i.status === 'open').sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  const done = list.filter((i) => i.status !== 'open');

  return (
    <Screen refreshing={invoices.loading && !!invoices.data} onRefresh={() => void reload()} offlineSince={invoices.offlineSince}>
      {!invoices.data && invoices.loading && <Loading />}
      {invoices.error && !invoices.data && <Notice kind="error">{invoices.error}</Notice>}
      {invoices.data && (
        <Card accent={open.length > 0}>
          {open.length === 0 ? (
            <Body>Vous êtes à jour.</Body>
          ) : (
            totalsByCurrency(open).map((t) => (
              <Body key={t.currency} bold>
                Reste à payer : {formatMoney(t.outstanding, t.currency)}
              </Body>
            ))
          )}
        </Card>
      )}
      {open.length > 0 && <Heading>À payer</Heading>}
      {open.map((i) => (
        <InvoiceRow key={i.id} invoice={i} />
      ))}
      {done.length > 0 && <Heading>Historique</Heading>}
      {done.map((i) => (
        <InvoiceRow key={i.id} invoice={i} />
      ))}
      {invoices.data && list.length === 0 && <Body muted>Aucune facture pour le moment.</Body>}
    </Screen>
  );
}

function InvoiceRow({ invoice: i }: { invoice: MyInvoice }) {
  const pending = i.payments.some((p) => p.status === 'pending');
  const overdue = i.status === 'open' && i.dueOn < new Date().toISOString().slice(0, 10);
  return (
    <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/paiements/[invoiceId]', params: { invoiceId: i.id } })}>
      <Card>
        <Row>
          <Body bold>{i.feeName}</Body>
          <Badge
            label={pending ? 'Paiement en cours' : overdue ? 'En retard' : INVOICE_LABELS[i.status]}
            tone={i.status === 'paid' ? 'success' : pending ? 'warning' : overdue ? 'danger' : 'neutral'}
          />
        </Row>
        <Body>
          {formatMoney(i.status === 'open' ? i.amountMinor - i.paidMinor : i.amountMinor, i.currency)}
          {i.paidMinor > 0 && i.status === 'open' ? ` restant sur ${formatMoney(i.amountMinor, i.currency)}` : ''}
        </Body>
        <Body muted>{i.status === 'paid' && i.paidAt ? `Payée le ${formatDay(i.paidAt)}` : `Échéance : ${formatDay(i.dueOn)}`}</Body>
      </Card>
    </Pressable>
  );
}
