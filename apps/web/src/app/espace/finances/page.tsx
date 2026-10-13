import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { FormattedDate } from '@/components/date';
import { AccessDenied, SpaceShell } from '@/components/space-shell';
import { getFeeStructures, getInvoices, getManifest, getPaymentProviders } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { formatMoney, INVOICE_LABELS, totalsByCurrency } from '@/lib/payments';
import { portalRequest } from '@/lib/request';
import type { PaymentProviderConfig } from '@/lib/types';
import { configurePaymentProvider, createFeeStructure, issueInvoices } from '../actions';

export const metadata: Metadata = { title: 'Finances' };

const FILTERS = [
  { key: undefined, label: 'Toutes' },
  { key: 'open', label: 'À payer' },
  { key: 'paid', label: 'Payées' },
] as const;

/** Frais de scolarité, factures, encaissements et moyens de paiement. */
export default async function FinancePage({ searchParams }: { searchParams: Promise<{ statut?: string }> }) {
  const { host, origin } = await portalRequest();
  const manifest = (await getManifest(host))!;
  const { me, accessToken } = await requireUser(host, '/espace/finances');
  const canRead = me.permissions.includes('finance:read');
  const canWriteFees = me.permissions.includes('fees:structures:write');
  const canConfigure = me.permissions.includes('tenant:config:write');
  if (!canRead && !canConfigure) {
    return (
      <SpaceShell manifest={manifest} title="Finances">
        <AccessDenied />
      </SpaceShell>
    );
  }
  const { statut } = await searchParams;
  const status = statut === 'open' || statut === 'paid' ? statut : undefined;
  const [fees, all, providers] = await Promise.all([
    canRead ? getFeeStructures(host, accessToken) : Promise.resolve([]),
    canRead ? getInvoices(host, accessToken) : Promise.resolve([]),
    canConfigure ? getPaymentProviders(host, accessToken) : Promise.resolve([]),
  ]);
  const invoices = status ? all.filter((i) => i.status === status) : all;
  const locale = manifest.locale;

  return (
    <SpaceShell manifest={manifest} title="Finances">
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

      {canConfigure && <ProvidersSection providers={providers} webhookBase={`${origin}/webhooks/payments`} slug={manifest.slug} />}
    </SpaceShell>
  );
}

function ProvidersSection({
  providers,
  webhookBase,
  slug,
}: {
  providers: PaymentProviderConfig[];
  webhookBase: string;
  slug: string;
}) {
  const stripe = providers.find((p) => p.provider === 'stripe');
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
          <h3>Carte bancaire (Stripe)</h3>
          <p className="card-meta">{stripe?.enabled ? 'Activé' : 'Non configuré'}</p>
          <p className="small">
            Adresse des notifications à déclarer dans Stripe (événements <code>checkout.session.*</code>) :
            <br />
            <code className="hash">{`${webhookBase}/stripe/${slug}`}</code>
          </p>
          <ActionForm action={configurePaymentProvider.bind(null, 'stripe')} className="form-grid">
            <label>
              Clé secrète
              <input name="secretKey" required autoComplete="off" placeholder="sk_live_…" className="text-input" />
            </label>
            <label>
              Secret de signature des webhooks
              <input name="webhookSecret" required autoComplete="off" placeholder="whsec_…" className="text-input" />
            </label>
            <SubmitButton>{stripe ? 'Remplacer les clés' : 'Activer Stripe'}</SubmitButton>
          </ActionForm>
        </li>
        <li className="card">
          <h3>Mobile Money (simulation)</h3>
          <p className="card-meta">{sandbox?.enabled ? 'Activé' : 'Non activé'}</p>
          <p className="small muted">
            Pour les démonstrations et la formation : la demande au téléphone et sa confirmation sont simulées, aucun
            argent ne circule. Indisponible en production, où un agrégateur Mobile Money (M-Pesa, Orange Money, Airtel
            Money) prendra le relais.
          </p>
          {!sandbox && (
            <ActionForm action={configurePaymentProvider.bind(null, 'sandbox')}>
              <SubmitButton variant="outline">Activer la simulation</SubmitButton>
            </ActionForm>
          )}
        </li>
      </ul>
    </section>
  );
}
