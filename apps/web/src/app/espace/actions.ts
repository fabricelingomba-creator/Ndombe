'use server';

import { revalidatePath } from 'next/cache';
import type { ActionResult } from '@/components/action-form';
import { apiSend } from '@/lib/api';
import { parseScore, UUID } from '@/lib/grades';
import { portalRequest } from '@/lib/request';
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
