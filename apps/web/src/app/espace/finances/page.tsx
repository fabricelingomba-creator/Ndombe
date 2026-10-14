import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { FormattedDate } from '@/components/date';
import { AccessDenied, SpaceShell } from '@/components/space-shell';
import { getBankAccounts, getBankSlips, getFeeStructures, getInvoices, getManifest, getPaymentProviders } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { formatMoney, INVOICE_LABELS, totalsByCurrency } from '@/lib/payments';
import { portalRequest } from '@/lib/request';
import type { BankAccount, BankSlipReview, FeeStructure, PaymentProviderConfig, StudentInvoice } from '@/lib/types';
import {
  configurePaymentProvider,
  createBankAccount,
  createFeeStructure,
  issueInvoices,
  reviewBankSlip,
  toggleBankAccount,
} from '../actions';

export const metadata: Metadata = { title: 'Finances' };

const FILTERS = [
  { key: undefined, label: 'Toutes' },
  { key: 'open', label: 'À payer' },
  { key: 'paid', label: 'Payées' },
] as const;

/** Frais de scolarité, factures, encaissements et moyens de paiement. */
export default async function FinancePage({ searchParams }: { searchParams: Promise<{ statut?: string }> }) {
  const { host } = await portalRequest();
  const manifest = (await getManifest(host))!;
  const { me, accessToken } = await requireUser(host, '/espace/finances');
  const canRead = me.permissions.includes('finance:read');
  const canWriteFees = me.permissions.includes('fees:structures:write');
  const canConfigure = me.permissions.includes('tenant:config:write');
  const canValidate = me.permissions.includes('payments:validate');
  if (!canRead && !canConfigure && !canValidate) {
    return (
      <SpaceShell manifest={manifest} title="Finances">
        <AccessDenied />
      </SpaceShell>
    );
  }
  const { statut } = await searchParams;
  const status = statut === 'open' || statut === 'paid' ? statut : undefined;
  const none = <T,>(): Promise<T[]> => Promise.resolve([]);
  const [fees, all, providers, accounts, pendingSlips, accepted, rejected] = await Promise.all([
    canRead ? getFeeStructures(host, accessToken) : none<FeeStructure>(),
    canRead ? getInvoices(host, accessToken) : none<StudentInvoice>(),
    canConfigure ? getPaymentProviders(host, accessToken) : none<PaymentProviderConfig>(),
    canRead ? getBankAccounts(host, accessToken) : none<BankAccount>(),
    canValidate ? getBankSlips(host, accessToken, 'pending') : none<BankSlipReview>(),
    canValidate ? getBankSlips(host, accessToken, 'accepted') : none<BankSlipReview>(),
    canValidate ? getBankSlips(host, accessToken, 'rejected') : none<BankSlipReview>(),
  ]);
  const decided = [...accepted, ...rejected]
    .sort((a, b) => (b.reviewedAt ?? '').localeCompare(a.reviewedAt ?? ''))
    .slice(0, 20);
  const invoices = status ? all.filter((i) => i.status === status) : all;
  const locale = manifest.locale;

  return (
    <SpaceShell manifest={manifest} title="Finances">
      {canValidate && <SlipsSection pending={pendingSlips} decided={decided} locale={locale} />}
      {canRead && (
        <>
          <dl className="stats">
            {totalsByCurrency(all.filter((i) => i.status !== 'cancelled')).map((t) => (
              <div key={t.currency}>
                <dt>Encaissé ({t.currency})</dt>
                <dd>{formatMoney(t.paid, t.currency, locale)}</dd>
                <dt>Reste à encaisser</dt>
                <dd className="small-dd">{formatMoney(t.outstanding, t.currency, locale)}</dd>
              </div>
            ))}
          </dl>

          <section className="queue" aria-labelledby="frais">
            <h2 id="frais">Frais de scolarité</h2>
            {fees.length === 0 ? (
              <p className="muted">Aucun frais défini.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Code</th>
                      <th scope="col">Intitulé</th>
                      <th scope="col" className="num">Montant</th>
                      <th scope="col">Échéance</th>
                      {canWriteFees && <th scope="col">Factures</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {fees.map((f) => (
                      <tr key={f.id}>
                        <td>
                          <strong>{f.code}</strong>
                        </td>
                        <td>{f.name}</td>
                        <td className="num">{formatMoney(f.amountMinor, f.currency, locale)}</td>
                        <td>
                          <FormattedDate iso={f.dueOn} locale={locale} />
                        </td>
                        {canWriteFees && (
                          <td>
                            <ActionForm action={issueInvoices.bind(null, f.id)}>
                              <SubmitButton variant="outline">Émettre aux étudiants</SubmitButton>
                            </ActionForm>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {canWriteFees && (
              <details className="card">
                <summary>Nouveau frais</summary>
                <ActionForm action={createFeeStructure} className="form-grid">
                  <label>
                    Code
                    <input name="code" required maxLength={32} placeholder="MIN-2026" className="text-input" />
                  </label>
                  <label>
                    Intitulé
                    <input name="name" required maxLength={200} placeholder="Minerval 2026-2027" className="text-input" />
                  </label>
                  <label>
                    Montant
                    <input name="amount" required inputMode="decimal" placeholder="250,00" className="text-input" />
                  </label>
                  <label>
                    Devise
                    <select name="currency" defaultValue="USD" className="text-input">
                      <option value="USD">Dollar américain (USD)</option>
                      <option value="CDF">Franc congolais (CDF)</option>
                    </select>
                  </label>
                  <label>
                    Échéance
                    <input name="dueOn" type="date" required className="text-input" />
                  </label>
                  <SubmitButton>Créer le frais</SubmitButton>
                </ActionForm>
              </details>
            )}
          </section>

          <section className="queue" aria-labelledby="factures">
            <h2 id="factures">
              Factures <span className="count">{invoices.length}</span>
            </h2>
            <nav className="chips" aria-label="Filtrer les factures">
              {FILTERS.map((f) => (
                <Link
                  key={f.label}
                  href={f.key ? `/espace/finances?statut=${f.key}` : '/espace/finances'}
                  className="chip"
                  aria-current={f.key === status ? 'page' : undefined}
                >
                  {f.label}
                </Link>
              ))}
            </nav>
            {invoices.length === 0 ? (
              <p className="muted">Aucune facture.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Étudiant</th>
                      <th scope="col">Frais</th>
                      <th scope="col" className="num">Montant</th>
                      <th scope="col" className="num">Payé</th>
                      <th scope="col">État</th>
                      <th scope="col">Échéance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((i) => (
                      <tr key={i.id}>
                        <td>
                          {i.studentName}
                          <div className="small muted">{i.studentEmail}</div>
                        </td>
                        <td>{i.feeName}</td>
                        <td className="num">{formatMoney(i.amountMinor, i.currency, locale)}</td>
                        <td className="num">{formatMoney(i.paidMinor, i.currency, locale)}</td>
                        <td>
                          <span className={`status invoice-${i.status}`}>{INVOICE_LABELS[i.status]}</span>
                        </td>
                        <td>
                          <FormattedDate iso={i.dueOn} locale={locale} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {(canRead || canConfigure) && <BankAccountsSection accounts={accounts} canConfigure={canConfigure} />}
      {canConfigure && <ProvidersSection providers={providers} />}
    </SpaceShell>
  );
}

function ProvidersSection({ providers }: { providers: PaymentProviderConfig[] }) {
  const sandbox = providers.find((p) => p.provider === 'sandbox');
  return (
    <section className="queue" aria-labelledby="moyens">
      <h2 id="moyens">Moyens de paiement</h2>
      <p className="small muted">
        Les clés sont chiffrées avant d’être enregistrées et ne sont plus jamais affichées. Chaque prestataire confirme les
        paiements par une notification signée envoyée à l’adresse indiquée.
      </p>
      <ul className="cards single">
        <li className="card">
          <h3>Mobile Money (simulation)</h3>
          <p className="card-meta">{sandbox?.enabled ? 'Activé' : 'Non activé'}</p>
          <p className="small muted">
            Pour les démonstrations et la formation : la demande au téléphone et sa confirmation sont simulées, aucun
            argent ne circule. Indisponible en production, où un agrégateur Mobile Money (M-Pesa, Orange Money, Airtel
            Money) prendra le relais.
          </p>
          {!sandbox?.enabled && (
            <ActionForm action={configurePaymentProvider.bind(null, 'sandbox')}>
              <SubmitButton variant="outline">Activer la simulation</SubmitButton>
            </ActionForm>
          )}
        </li>
      </ul>
    </section>
  );
}

/** Bordereaux bancaires envoyés par les étudiants : contrôle, puis validation ou refus. */
function SlipsSection({
  pending,
  decided,
  locale,
}: {
  pending: BankSlipReview[];
  decided: BankSlipReview[];
  locale: string;
}) {
  return (
    <section className="queue" aria-labelledby="bordereaux">
      <h2 id="bordereaux">
        Bordereaux à valider <span className="count">{pending.length}</span>
      </h2>
      <p className="small muted">
        Avant de valider, ouvrez le bordereau et vérifiez que le dépôt figure sur le relevé du compte, au bon montant.
        Valider règle la facture de l’étudiant ; la décision est définitive.
      </p>
      {pending.length === 0 ? (
        <p className="muted">Aucun bordereau en attente.</p>
      ) : (
        <ul className="cards single">
          {pending.map((slip) => (
            <li key={slip.id} className="card">
              <div className="row-card">
                <div>
                  <p className="card-meta">
                    Reçu le <FormattedDate iso={slip.submittedAt} locale={locale} />
                  </p>
                  <h3>{slip.studentName}</h3>
                  <p className="small muted">
                    {slip.studentEmail} · {slip.feeName}
                  </p>
                </div>
                <p className="amount">{formatMoney(slip.amountMinor, slip.currency, locale)}</p>
              </div>
              <dl className="slip-grid">
                <dt>Bordereau</dt>
                <dd className="hash">{slip.reference}</dd>
                <dt>Banque</dt>
                <dd>
                  {slip.bankName} · <span className="hash">{slip.accountNumber}</span>
                </dd>
                <dt>Date du dépôt</dt>
                <dd>
                  <FormattedDate iso={slip.paidOn} locale={locale} />
                </dd>
                <dt>Facture</dt>
                <dd>{formatMoney(slip.invoiceAmountMinor, slip.currency, locale)}</dd>
              </dl>
              <a className="button button-outline-dark" href={`/espace/finances/bordereaux/${slip.id}`} target="_blank" rel="noopener">
                {slip.fileType === 'application/pdf' ? 'Télécharger le bordereau (PDF)' : 'Voir le bordereau'}
              </a>
              <div className="review-actions">
                <ActionForm action={reviewBankSlip.bind(null, slip.id, 'accept')}>
                  <SubmitButton>Valider le paiement</SubmitButton>
                </ActionForm>
                <ActionForm action={reviewBankSlip.bind(null, slip.id, 'reject')} className="return-form">
                  <label htmlFor={`reason-${slip.id}`}>Motif du refus (visible par l’étudiant)</label>
                  <textarea id={`reason-${slip.id}`} name="reason" rows={2} maxLength={500} required minLength={3} />
                  <SubmitButton variant="outline">Refuser</SubmitButton>
                </ActionForm>
              </div>
            </li>
          ))}
        </ul>
      )}
      {decided.length > 0 && (
        <details className="card">
          <summary>Derniers bordereaux traités</summary>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Étudiant</th>
                  <th scope="col">Bordereau</th>
                  <th scope="col" className="num">Montant</th>
                  <th scope="col">Décision</th>
                  <th scope="col">Par</th>
                </tr>
              </thead>
              <tbody>
                {decided.map((slip) => (
                  <tr key={slip.id}>
                    <td>{slip.studentName}</td>
                    <td className="hash">{slip.reference}</td>
                    <td className="num">{formatMoney(slip.amountMinor, slip.currency, locale)}</td>
                    <td>
                      <span className={`status ${slip.decision === 'accepted' ? 'payment-succeeded' : 'payment-failed'}`}>
                        {slip.decision === 'accepted' ? 'Validé' : 'Refusé'}
                      </span>
                      {slip.failureReason && <div className="small muted">{slip.failureReason}</div>}
                    </td>
                    <td>{slip.reviewerName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}

/** Comptes sur lesquels les étudiants déposent leurs frais. */
function BankAccountsSection({ accounts, canConfigure }: { accounts: BankAccount[]; canConfigure: boolean }) {
  return (
    <section className="queue" aria-labelledby="comptes">
      <h2 id="comptes">Comptes bancaires</h2>
      {accounts.length === 0 ? (
        <p className="muted">Aucun compte : les étudiants ne peuvent pas encore payer à la banque.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Banque</th>
                <th scope="col">Titulaire</th>
                <th scope="col">Numéro</th>
                <th scope="col">Devise</th>
                <th scope="col">État</th>
                {canConfigure && <th scope="col" />}
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>{a.bankName}</td>
                  <td>{a.accountName}</td>
                  <td className="hash">{a.accountNumber}</td>
                  <td>{a.currency}</td>
                  <td>{a.enabled ? 'Proposé aux étudiants' : 'Retiré'}</td>
                  {canConfigure && (
                    <td>
                      <ActionForm action={toggleBankAccount.bind(null, a.id, !a.enabled)}>
                        <SubmitButton variant="outline">{a.enabled ? 'Retirer' : 'Réactiver'}</SubmitButton>
                      </ActionForm>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canConfigure && (
        <details className="card">
          <summary>Ajouter un compte</summary>
          <ActionForm action={createBankAccount} className="form-grid">
            <label>
              Banque
              <input name="bankName" required maxLength={100} placeholder="Rawbank" className="text-input" />
            </label>
            <label>
              Titulaire du compte
              <input name="accountName" required maxLength={200} placeholder="Université de …" className="text-input" />
            </label>
            <label>
              Numéro de compte
              <input name="accountNumber" required maxLength={64} placeholder="05100-0001234-56" className="text-input" />
            </label>
            <label>
              Devise
              <select name="currency" defaultValue="USD" className="text-input">
                <option value="USD">Dollar américain (USD)</option>
                <option value="CDF">Franc congolais (CDF)</option>
              </select>
            </label>
            <SubmitButton>Ajouter le compte</SubmitButton>
          </ActionForm>
        </details>
      )}
    </section>
  );
}
