import type { Metadata } from 'next';
import { randomUUID } from 'node:crypto';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { FormattedDate } from '@/components/date';
import { AccessDenied, SpaceShell } from '@/components/space-shell';
import { getManifest, getMyBankAccounts, getMyInvoices, getPaymentOptions } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { formatMoney, INVOICE_LABELS, PAYMENT_LABELS, totalsByCurrency } from '@/lib/payments';
import { portalRequest } from '@/lib/request';
import type { BankAccount, MyInvoice, Payment, PaymentOption } from '@/lib/types';
import { confirmSandboxPayment, declareBankPayment, startPayment } from '../actions';

export const metadata: Metadata = { title: 'Paiements' };

/** Même délai que l'API : un paiement en attente plus récent bloque un nouvel essai. */
const PENDING_LOCK_MS = 30 * 60 * 1000;

/** Factures de l'étudiant, paiement Mobile Money ou par banque (bordereau), historique. */
export default async function MyPaymentsPage({ searchParams }: { searchParams: Promise<{ paiement?: string }> }) {
  const { host } = await portalRequest();
  const manifest = (await getManifest(host))!;
  const { me, accessToken } = await requireUser(host, '/espace/paiements');
  if (!me.permissions.includes('self:payments:write')) {
    return (
      <SpaceShell manifest={manifest} title="Paiements">
        <AccessDenied />
      </SpaceShell>
    );
  }
  const [invoices, options, accounts] = await Promise.all([
    getMyInvoices(host, accessToken),
    getPaymentOptions(host, accessToken),
    getMyBankAccounts(host, accessToken),
  ]);
  const { paiement } = await searchParams;
  const returned = paiement ? invoices.flatMap((i) => i.payments).find((p) => p.id === paiement) : undefined;
  const open = invoices.filter((i) => i.status === 'open');
  const paid = invoices.filter((i) => i.status === 'paid');
  const payments = invoices.flatMap((i) => i.payments.map((p) => ({ ...p, feeName: i.feeName })));
  const locale = manifest.locale;

  return (
    <SpaceShell manifest={manifest} title="Paiements">
      {returned && <ReturnBanner payment={returned} />}
      {invoices.length === 0 && <p className="muted">Aucune facture pour le moment.</p>}
      {open.length > 0 && (
        <dl className="stats">
          {totalsByCurrency(open).map((t) => (
            <div key={t.currency}>
              <dt>Reste à payer ({t.currency})</dt>
              <dd>{formatMoney(t.outstanding, t.currency, locale)}</dd>
            </div>
          ))}
        </dl>
      )}

      {open.length > 0 && (
        <section className="queue" aria-labelledby="a-payer">
          <h2 id="a-payer">
            À payer <span className="count">{open.length}</span>
          </h2>
          {options.length === 0 && accounts.length === 0 && (
            <p className="alert">Le paiement en ligne n’est pas encore ouvert par votre université.</p>
          )}
          <ul className="cards single">
            {open.map((invoice) => (
              <OpenInvoice key={invoice.id} invoice={invoice} options={options} accounts={accounts} locale={locale} />
            ))}
          </ul>
        </section>
      )}

      {paid.length > 0 && (
        <section className="queue" aria-labelledby="payees">
          <h2 id="payees">Factures réglées</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Frais</th>
                  <th scope="col" className="num">Montant</th>
                  <th scope="col">Réglée le</th>
                </tr>
              </thead>
              <tbody>
                {paid.map((i) => (
                  <tr key={i.id}>
                    <td>{i.feeName}</td>
                    <td className="num">{formatMoney(i.amountMinor, i.currency, locale)}</td>
                    <td>{i.paidAt && <FormattedDate iso={i.paidAt} locale={locale} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {payments.length > 0 && (
        <section className="queue" aria-labelledby="historique">
          <h2 id="historique">Historique des paiements</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Frais</th>
                  <th scope="col">Moyen</th>
                  <th scope="col" className="num">Montant</th>
                  <th scope="col">État</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <FormattedDate iso={p.createdAt} locale={locale} />
                    </td>
                    <td>{p.feeName}</td>
                    <td>
                      {p.provider === 'bank' ? `Banque${p.bankName ? ` (${p.bankName})` : ''}` : 'Mobile Money'}
                      {p.slipReference && <div className="small muted">Bordereau {p.slipReference}</div>}
                    </td>
                    <td className="num">{formatMoney(p.amountMinor, p.currency, locale)}</td>
                    <td>
                      <span className={`status payment-${p.status}`}>
                        {p.provider === 'bank' && p.status === 'failed' ? 'Refusé' : PAYMENT_LABELS[p.status]}
                      </span>
                      {p.failureReason && <span className="small muted"> · {p.failureReason}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </SpaceShell>
  );
}

function ReturnBanner({ payment }: { payment: Payment }) {
  if (payment.status === 'succeeded') return <p className="notice">Paiement reçu, merci. Votre facture est à jour.</p>;
  if (payment.status === 'failed') return <p className="alert">Le paiement n’a pas abouti : {payment.failureReason}.</p>;
  return (
    <p className="notice">
      Paiement en cours de confirmation par le prestataire. Rechargez la page dans quelques instants.
    </p>
  );
}

function OpenInvoice({
  invoice,
  options,
  accounts,
  locale,
}: {
  invoice: MyInvoice;
  options: PaymentOption[];
  accounts: BankAccount[];
  locale: string;
}) {
  const balance = invoice.amountMinor - invoice.paidMinor;
  // Un bordereau attend la décision du service financier, quel que soit son âge.
  const pending = invoice.payments.find(
    (p) =>
      p.status === 'pending' && (p.provider === 'bank' || Date.now() - new Date(p.createdAt).getTime() < PENDING_LOCK_MS),
  );
  const rejected = invoice.payments.find((p) => p.provider === 'bank' && p.status === 'failed');
  const bankAccounts = accounts.filter((a) => a.currency === invoice.currency);
  const overdue = new Date(`${invoice.dueOn}T23:59:59Z`).getTime() < Date.now();
  return (
    <li className="card">
      <div className="row-card">
        <div>
          <p className="card-meta">
            {INVOICE_LABELS[invoice.status]} · échéance <FormattedDate iso={invoice.dueOn} locale={locale} />
            {overdue && <span className="fail"> · en retard</span>}
          </p>
          <h3>{invoice.feeName}</h3>
          {invoice.paidMinor > 0 && (
            <p className="small muted">Déjà payé : {formatMoney(invoice.paidMinor, invoice.currency, locale)}</p>
          )}
        </div>
        <p className="amount">{formatMoney(balance, invoice.currency, locale)}</p>
      </div>

      {!pending && rejected && rejected === invoice.payments.find((p) => p.provider === 'bank') && (
        <p className="alert">
          Votre bordereau {rejected.slipReference} a été refusé : {rejected.failureReason}. Vous pouvez en envoyer un
          nouveau.
        </p>
      )}
      {pending ? (
        <PendingPayment payment={pending} />
      ) : (
        options.length > 0 && (
          <ActionForm action={startPayment.bind(null, invoice.id)} className="pay-form">
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <fieldset>
              <legend>Moyen de paiement</legend>
              {options.map((o, index) => (
                <label key={o.provider} className="choice">
                  <input
                    type="radio"
                    name="provider"
                    value={o.provider}
                    defaultChecked={index === 0}
                    data-phone={o.requiresPhone ? '' : undefined}
                  />
                  {o.label}
                </label>
              ))}
            </fieldset>
            <div className="phone-field">
              <label htmlFor={`phone-${invoice.id}`}>Numéro Mobile Money</label>
              <input
                id={`phone-${invoice.id}`}
                name="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="0812 345 678"
                className="text-input"
              />
            </div>
            <SubmitButton>Payer {formatMoney(balance, invoice.currency, locale)}</SubmitButton>
          </ActionForm>
        )
      )}
      {!pending && bankAccounts.length > 0 && (
        <BankPaymentForm invoice={invoice} balance={balance} accounts={bankAccounts} locale={locale} />
      )}
    </li>
  );
}

/** Dépôt à la banque : les comptes de l'université, puis l'envoi du bordereau. */
function BankPaymentForm({
  invoice,
  balance,
  accounts,
  locale,
}: {
  invoice: MyInvoice;
  balance: number;
  accounts: BankAccount[];
  locale: string;
}) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <details className="bank-pay">
      <summary>Payer à la banque et envoyer le bordereau</summary>
      <p className="small">
        Déposez {formatMoney(balance, invoice.currency, locale)} sur l’un de ces comptes en indiquant votre nom et
        « {invoice.feeName} », puis envoyez la photo ou le PDF du bordereau remis par la banque.
      </p>
      <ul className="accounts">
        {accounts.map((a) => (
          <li key={a.id}>
            <strong>{a.bankName}</strong> · {a.accountName}
            <div className="hash">{a.accountNumber}</div>
          </li>
        ))}
      </ul>
      <ActionForm action={declareBankPayment.bind(null, invoice.id)} className="form-grid">
        <input type="hidden" name="idempotencyKey" value={randomUUID()} />
        {accounts.length > 1 ? (
          <label>
            Banque du dépôt
            <select name="bankAccountId" required className="text-input">
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.bankName} · {a.accountNumber}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <input type="hidden" name="bankAccountId" value={accounts[0].id} />
        )}
        <label>
          Numéro du bordereau
          <input
            name="reference"
            required
            minLength={3}
            maxLength={64}
            pattern="[A-Za-z0-9][A-Za-z0-9/._\-]{2,63}"
            title="Lettres, chiffres et / . _ - uniquement"
            autoComplete="off"
            className="text-input"
          />
        </label>
        <label>
          Date du dépôt
          <input name="paidOn" type="date" required max={today} defaultValue={today} className="text-input" />
        </label>
        <label>
          Montant déposé ({invoice.currency})
          <input
            name="amount"
            required
            inputMode="decimal"
            defaultValue={String(balance / 100).replace('.', ',')}
            className="text-input"
          />
        </label>
        <label>
          Photo ou PDF du bordereau
          <input name="slip" type="file" required accept="image/jpeg,image/png,application/pdf" className="text-input" />
          <span className="small muted">5 Mo au plus. Le numéro, la date et le montant doivent être lisibles.</span>
        </label>
        <SubmitButton>Envoyer le bordereau</SubmitButton>
      </ActionForm>
    </details>
  );
}

function PendingPayment({ payment }: { payment: Payment }) {
  if (payment.provider === 'bank') {
    return (
      <p className="notice">
        Bordereau {payment.slipReference} reçu{payment.bankName ? ` (${payment.bankName})` : ''} : en attente de
        validation par le service financier. Vous serez fixé dès qu’il aura vérifié le dépôt sur le compte de
        l’université.
      </p>
    );
  }
  if (payment.redirectUrl) {
    return (
      <div className="pending">
        <p className="notice">Un paiement est en cours sur la page du prestataire.</p>
        {payment.redirectUrl && (
          <a className="button" href={payment.redirectUrl}>
            Reprendre le paiement
          </a>
        )}
      </div>
    );
  }
  return (
    <div className="pending">
      <p className="notice">
        Une demande de paiement a été envoyée à votre téléphone. Validez-la avec votre code secret Mobile Money, puis
        rechargez cette page.
      </p>
      {payment.provider === 'sandbox' && (
        <div className="sandbox">
          <p className="small muted">Mode démonstration : aucun argent réel. Simulez la réponse du téléphone.</p>
          <div className="actions">
            <ActionForm action={confirmSandboxPayment.bind(null, payment.id, 'succeeded')}>
              <SubmitButton>Simuler la validation</SubmitButton>
            </ActionForm>
            <ActionForm action={confirmSandboxPayment.bind(null, payment.id, 'failed')}>
              <SubmitButton variant="outline">Simuler un refus</SubmitButton>
            </ActionForm>
          </div>
        </div>
      )}
    </div>
  );
}
