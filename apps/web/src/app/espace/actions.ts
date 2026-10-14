'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { ActionResult } from '@/components/action-form';
import { apiSend, apiSendForm, getPaymentOptions } from '@/lib/api';
import { parseScore, UUID } from '@/lib/grades';
import { normalizePhone, parseAmount } from '@/lib/payments';
import { portalRequest } from '@/lib/request';
import { safeReturnTo } from '@/lib/return-to';
import { readAccess } from '@/lib/session';

/**
 * Actions serveur de l'espace connecté. Le navigateur n'envoie que des
 * valeurs de formulaire : le jeton reste dans le cookie chiffré et l'API
 * revérifie chaque permission.
 */
async function session() {
  const { host } = await portalRequest();
  const access = await readAccess(host);
  return access ? { host, token: access.accessToken } : null;
}

const EXPIRED: ActionResult = { ok: false, message: 'Session expirée : rechargez la page pour vous reconnecter.' };

export async function saveGrades(offeringId: string, _prev: ActionResult, form: FormData): Promise<ActionResult> {
  if (!UUID.test(offeringId)) return { ok: false, message: 'Offre invalide.' };
  const s = await session();
  if (!s) return EXPIRED;

  const grades: { enrollmentId: string; score: number | null }[] = [];
  const invalid: string[] = [];
  for (const [key, value] of form.entries()) {
    if (!key.startsWith('score:') || typeof value !== 'string') continue;
    const enrollmentId = key.slice('score:'.length);
    if (!UUID.test(enrollmentId)) continue;
    const score = parseScore(value);
    if (score === undefined) invalid.push(value);
    else grades.push({ enrollmentId, score });
  }
  if (invalid.length > 0) {
    return { ok: false, message: `Note invalide : ${invalid.slice(0, 3).join(', ')}. Saisissez une note entre 0 et 20.` };
  }

  const base = `/v1/offerings/${offeringId}`;
  if (grades.length > 0) {
    const saved = await apiSend<{ updated: number }>(s.host, `${base}/grades`, s.token, 'PUT', { grades });
    if (!saved.ok) return { ok: false, message: saved.message };
  }
  revalidatePath(`/espace/notation/${offeringId}`);

  if (form.get('intent') === 'submit') {
    const submitted = await apiSend(s.host, `${base}/grades/submit`, s.token, 'POST');
    if (!submitted.ok) return { ok: false, message: `Notes enregistrées, mais non soumises : ${submitted.message}` };
    revalidatePath('/espace/notation');
    return { ok: true, message: 'Notes soumises pour validation.' };
  }
  return { ok: true, message: 'Notes enregistrées.' };
}

export async function reviewGrades(
  offeringId: string,
  decision: 'approve' | 'return' | 'publish',
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  // Les arguments liés transitent par le navigateur : on les revalide ici.
  if (!UUID.test(offeringId) || !['approve', 'return', 'publish'].includes(decision)) {
    return { ok: false, message: 'Action invalide.' };
  }
  const s = await session();
  if (!s) return EXPIRED;

  const reason = String(form.get('reason') ?? '').trim();
  if (decision === 'return' && reason.length < 3) return { ok: false, message: 'Indiquez le motif du renvoi.' };
  const body = decision === 'return' ? { reason } : undefined;
  const res = await apiSend(s.host, `/v1/offerings/${offeringId}/grades/${decision}`, s.token, 'POST', body);
  if (!res.ok) return { ok: false, message: res.message };
  revalidatePath(`/espace/validation-notes/${offeringId}`);
  revalidatePath('/espace/validation-notes');
  const done = { approve: 'Notes approuvées.', return: 'Feuille renvoyée au professeur.', publish: 'Notes publiées aux étudiants.' };
  return { ok: true, message: done[decision] };
}

export async function requestTranscript(_prev: ActionResult, _form: FormData): Promise<ActionResult> {
  const s = await session();
  if (!s) return EXPIRED;
  const res = await apiSend(s.host, '/v1/me/transcripts', s.token, 'POST');
  if (!res.ok) return { ok: false, message: res.message };
  revalidatePath('/espace/notes');
  return { ok: true, message: 'Demande envoyée au secrétariat académique.' };
}

export async function decideTranscript(
  transcriptId: string,
  decision: 'validate' | 'reject',
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  // Les arguments liés transitent par le navigateur : on les revalide ici.
  if (!UUID.test(transcriptId) || !['validate', 'reject'].includes(decision)) {
    return { ok: false, message: 'Action invalide.' };
  }
  const s = await session();
  if (!s) return EXPIRED;
  const reason = String(form.get('reason') ?? '').trim();
  if (decision === 'reject' && reason.length < 3) return { ok: false, message: 'Indiquez le motif du refus.' };
  const res = await apiSend<{ verificationCode?: string }>(
    s.host,
    `/v1/transcripts/${transcriptId}/${decision}`,
    s.token,
    'POST',
    decision === 'reject' ? { reason } : undefined,
  );
  if (!res.ok) return { ok: false, message: res.message };
  revalidatePath('/espace/releves-validation');
  return {
    ok: true,
    message: decision === 'validate' ? `Relevé émis (code ${res.data.verificationCode}).` : 'Demande refusée.',
  };
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Lance le paiement d'une facture. La clé d'idempotence est générée au rendu
 * de la page : un double clic renvoie le même paiement au lieu d'en créer deux.
 */
export async function startPayment(invoiceId: string, _prev: ActionResult, form: FormData): Promise<ActionResult> {
  if (!UUID.test(invoiceId)) return { ok: false, message: 'Facture invalide.' };
  const idempotencyKey = String(form.get('idempotencyKey') ?? '');
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) return { ok: false, message: 'Formulaire expiré : rechargez la page.' };
  const s = await session();
  if (!s) return EXPIRED;

  const provider = String(form.get('provider') ?? '');
  const options = await getPaymentOptions(s.host, s.token);
  const option = options.find((o) => o.provider === provider);
  if (!option) return { ok: false, message: 'Choisissez un moyen de paiement.' };
  let phone: string | undefined;
  if (option.requiresPhone) {
    phone = normalizePhone(String(form.get('phone') ?? ''));
    if (!phone) return { ok: false, message: 'Numéro Mobile Money invalide, par exemple 0812 345 678 ou +243812345678.' };
  }

  const { origin } = await portalRequest();
  const res = await apiSend<{ id: string; status: string; redirectUrl: string | null; instructions?: string }>(
    s.host,
    `/v1/me/invoices/${invoiceId}/payments`,
    s.token,
    'POST',
    { provider, phone, returnUrl: `${origin}/espace/paiements` },
    { 'idempotency-key': idempotencyKey },
  );
  if (!res.ok) return { ok: false, message: res.message };
  // Prestataire qui héberge sa propre page de paiement : on y envoie l'étudiant.
  if (res.data.redirectUrl && res.data.status === 'pending') redirect(res.data.redirectUrl);
  revalidatePath('/espace/paiements');
  return { ok: true, message: res.data.instructions ?? 'Paiement lancé.' };
}

/** Hors production : simule la réponse de l'étudiant sur son téléphone. */
export async function confirmSandboxPayment(
  paymentId: string,
  outcome: 'succeeded' | 'failed',
  _prev: ActionResult,
  _form: FormData,
): Promise<ActionResult> {
  if (!UUID.test(paymentId) || !['succeeded', 'failed'].includes(outcome)) return { ok: false, message: 'Action invalide.' };
  const s = await session();
  if (!s) return EXPIRED;
  const res = await apiSend(s.host, `/v1/me/payments/${paymentId}/sandbox-confirm`, s.token, 'POST', { outcome });
  if (!res.ok) return { ok: false, message: res.message };
  revalidatePath('/espace/paiements');
  return { ok: true, message: outcome === 'succeeded' ? 'Paiement confirmé.' : 'Paiement refusé.' };
}

export async function createFeeStructure(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const s = await session();
  if (!s) return EXPIRED;
  const amount = parseAmount(String(form.get('amount') ?? ''));
  if (amount === undefined) return { ok: false, message: 'Montant invalide (deux décimales au plus).' };
  const res = await apiSend(s.host, '/v1/fee-structures', s.token, 'POST', {
    code: String(form.get('code') ?? '').trim().toUpperCase(),
    name: String(form.get('name') ?? '').trim(),
    amount,
    currency: String(form.get('currency') ?? ''),
    dueOn: String(form.get('dueOn') ?? ''),
  });
  if (!res.ok) return { ok: false, message: res.status === 409 ? 'Ce code de frais existe déjà.' : res.message };
  revalidatePath('/espace/finances');
  return { ok: true, message: 'Frais créé. Émettez maintenant les factures.' };
}

export async function issueInvoices(feeId: string, _prev: ActionResult, _form: FormData): Promise<ActionResult> {
  if (!UUID.test(feeId)) return { ok: false, message: 'Frais invalide.' };
  const s = await session();
  if (!s) return EXPIRED;
  const res = await apiSend<{ created: number }>(s.host, `/v1/fee-structures/${feeId}/invoices`, s.token, 'POST');
  if (!res.ok) return { ok: false, message: res.message };
  revalidatePath('/espace/finances');
  const n = res.data.created;
  return { ok: true, message: n === 0 ? 'Tous les étudiants ont déjà leur facture.' : `${n} facture${n > 1 ? 's' : ''} émise${n > 1 ? 's' : ''}.` };
}

export async function configurePaymentProvider(
  provider: 'sandbox',
  _prev: ActionResult,
  _form: FormData,
): Promise<ActionResult> {
  if (provider !== 'sandbox') return { ok: false, message: 'Prestataire invalide.' };
  const s = await session();
  if (!s) return EXPIRED;
  const res = await apiSend(s.host, `/v1/payment-providers/${provider}`, s.token, 'PUT', {});
  if (!res.ok) return { ok: false, message: res.status === 404 ? 'Ce moyen de paiement n’est pas disponible sur cette plateforme.' : res.message };
  revalidatePath('/espace/finances');
  return { ok: true, message: 'Mobile Money simulé activé.' };
}

const SLIP_MAX_BYTES = 5 * 1024 * 1024;
const SLIP_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];

/**
 * Paiement par banque : l'étudiant déclare son dépôt et téléverse le
 * bordereau. L'API vérifie le fichier (contenu réel, taille, doublons).
 */
export async function declareBankPayment(invoiceId: string, _prev: ActionResult, form: FormData): Promise<ActionResult> {
  if (!UUID.test(invoiceId)) return { ok: false, message: 'Facture invalide.' };
  const idempotencyKey = String(form.get('idempotencyKey') ?? '');
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) return { ok: false, message: 'Formulaire expiré : rechargez la page.' };
  const slip = form.get('slip');
  if (!(slip instanceof File) || slip.size === 0) return { ok: false, message: 'Joignez la photo ou le PDF du bordereau.' };
  if (slip.size > SLIP_MAX_BYTES) return { ok: false, message: 'Fichier trop lourd (5 Mo au plus).' };
  if (slip.type && !SLIP_TYPES.includes(slip.type)) return { ok: false, message: 'Envoyez une photo (JPEG, PNG) ou un PDF.' };
  const amount = parseAmount(String(form.get('amount') ?? ''));
  if (amount === undefined) return { ok: false, message: 'Montant invalide.' };
  const s = await session();
  if (!s) return EXPIRED;

  const body = new FormData();
  body.set('bankAccountId', String(form.get('bankAccountId') ?? ''));
  body.set('reference', String(form.get('reference') ?? '').trim());
  body.set('paidOn', String(form.get('paidOn') ?? ''));
  body.set('amount', String(amount));
  body.set('slip', slip, slip.name || 'bordereau');
  const res = await apiSendForm(s.host, `/v1/me/invoices/${invoiceId}/bank-payments`, s.token, body, {
    'idempotency-key': idempotencyKey,
  });
  if (!res.ok) return { ok: false, message: res.message };
  revalidatePath('/espace/paiements');
  return { ok: true, message: 'Bordereau envoyé. Le service financier va le vérifier.' };
}

export async function reviewBankSlip(
  paymentId: string,
  decision: 'accept' | 'reject',
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  // Les arguments liés transitent par le navigateur : on les revalide ici.
  if (!UUID.test(paymentId) || !['accept', 'reject'].includes(decision)) return { ok: false, message: 'Action invalide.' };
  const s = await session();
  if (!s) return EXPIRED;
  const reason = String(form.get('reason') ?? '').trim();
  if (decision === 'reject' && reason.length < 3) return { ok: false, message: 'Indiquez le motif du refus.' };
  const res = await apiSend<{ invoiceStatus: string }>(
    s.host,
    `/v1/bank-payments/${paymentId}/${decision}`,
    s.token,
    'POST',
    decision === 'reject' ? { reason } : undefined,
  );
  if (!res.ok) return { ok: false, message: res.message };
  revalidatePath('/espace/finances');
  if (decision === 'reject') return { ok: true, message: 'Bordereau refusé.' };
  return { ok: true, message: res.data.invoiceStatus === 'paid' ? 'Paiement validé, facture réglée.' : 'Paiement validé.' };
}

export async function createBankAccount(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const s = await session();
  if (!s) return EXPIRED;
  const res = await apiSend(s.host, '/v1/bank-accounts', s.token, 'POST', {
    bankName: String(form.get('bankName') ?? '').trim(),
    accountName: String(form.get('accountName') ?? '').trim(),
    accountNumber: String(form.get('accountNumber') ?? '').trim(),
    currency: String(form.get('currency') ?? ''),
  });
  if (!res.ok) return { ok: false, message: res.status === 409 ? 'Ce compte existe déjà.' : res.message };
  revalidatePath('/espace/finances');
  return { ok: true, message: 'Compte ajouté : les étudiants peuvent y déposer leurs frais.' };
}

export async function toggleBankAccount(accountId: string, enabled: boolean, _prev: ActionResult, _form: FormData): Promise<ActionResult> {
  if (!UUID.test(accountId) || typeof enabled !== 'boolean') return { ok: false, message: 'Action invalide.' };
  const s = await session();
  if (!s) return EXPIRED;
  const res = await apiSend(s.host, `/v1/bank-accounts/${accountId}`, s.token, 'PUT', { enabled });
  if (!res.ok) return { ok: false, message: res.message };
  revalidatePath('/espace/finances');
  return { ok: true, message: enabled ? 'Compte réactivé.' : 'Compte retiré des choix proposés aux étudiants.' };
}

/** Ouvre une notification : elle est marquée lue, puis on suit son lien interne. */
export async function openNotification(notificationId: string): Promise<void> {
  if (!UUID.test(notificationId)) return;
  const s = await session();
  if (!s) redirect('/connexion?returnTo=%2Fespace%2Fnotifications');
  // Le lien vient de l'API (et non du formulaire) ; il reste limité au portail.
  const res = await apiSend<{ link: string | null }>(s.host, `/v1/me/notifications/${notificationId}/read`, s.token, 'POST');
  revalidatePath('/espace/notifications');
  redirect(safeReturnTo(res.ok ? res.data.link : null, '/espace/notifications'));
}

export async function markAllNotificationsRead(_prev: ActionResult, _form: FormData): Promise<ActionResult> {
  const s = await session();
  if (!s) return EXPIRED;
  const res = await apiSend<{ updated: number }>(s.host, '/v1/me/notifications/read-all', s.token, 'POST');
  if (!res.ok) return { ok: false, message: res.message };
  revalidatePath('/espace/notifications');
  return { ok: true, message: res.data.updated ? 'Toutes les notifications sont lues.' : 'Rien de nouveau.' };
}

const NOTIFICATION_CATEGORIES = ['finance', 'academic', 'tasks', 'announcements'] as const;

export async function saveNotificationPreferences(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const s = await session();
  if (!s) return EXPIRED;
  // Une case décochée n'est pas envoyée : chaque catégorie affichée porte un champ « shown ».
  const shown = new Set(form.getAll('shown').map(String));
  const email: Record<string, boolean> = {};
  for (const category of NOTIFICATION_CATEGORIES) {
    if (shown.has(category)) email[category] = form.get(`email:${category}`) === 'on';
  }
  const res = await apiSend(s.host, '/v1/me/notification-preferences', s.token, 'PUT', { email });
  if (!res.ok) return { ok: false, message: res.message };
  revalidatePath('/espace/notifications');
  return { ok: true, message: 'Préférences enregistrées.' };
}
