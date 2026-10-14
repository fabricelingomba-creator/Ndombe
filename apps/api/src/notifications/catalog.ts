import { formatMoney } from '../payments/money';

/**
 * Catalogue des notifications : chaque événement métier produit un message
 * prêt à afficher (dans l'application) et à envoyer (par e-mail). Les textes
 * sont construits ici, à un seul endroit, à partir de données déjà vérifiées.
 */
export const NOTIFICATION_CATEGORIES = ['finance', 'academic', 'tasks', 'announcements'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  finance: 'Factures et paiements',
  academic: 'Notes et relevés',
  tasks: 'Tâches à traiter',
  announcements: 'Annonces de l’université',
};

export interface NotificationMessage {
  kind: string;
  category: NotificationCategory;
  title: string;
  body: string;
  /** Chemin dans le portail, par exemple /espace/paiements. */
  link: string | null;
  /** Un même destinataire ne reçoit qu'une fois un message de même clé. */
  dedupKey?: string;
}

/** 2026-10-31 → « 31 octobre 2026 ». */
export function formatDate(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(`${value.slice(0, 10)}T12:00:00Z`) : value;
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

interface InvoiceInfo {
  feeName: string;
  amountMinor: number | string;
  currency: string;
  dueOn: string | Date;
}

export const messages = {
  invoiceIssued: (i: InvoiceInfo): NotificationMessage => ({
    kind: 'invoice.issued',
    category: 'finance',
    title: `Nouvelle facture : ${clip(i.feeName, 150)}`,
    body: `Montant : ${formatMoney(i.amountMinor, i.currency)}, à régler avant le ${formatDate(i.dueOn)}.`,
    link: '/espace/paiements',
  }),

  invoiceDueSoon: (invoiceId: string, i: InvoiceInfo): NotificationMessage => ({
    kind: 'invoice.due_soon',
    category: 'finance',
    title: `Rappel : ${clip(i.feeName, 150)} à régler avant le ${formatDate(i.dueOn)}`,
    body: `Il reste ${formatMoney(i.amountMinor, i.currency)} à payer. Vous pouvez régler par Mobile Money ou par banque depuis votre espace.`,
    link: '/espace/paiements',
    dedupKey: `invoice.due_soon:${invoiceId}`,
  }),

  invoiceOverdue: (invoiceId: string, i: InvoiceInfo): NotificationMessage => ({
    kind: 'invoice.overdue',
    category: 'finance',
    title: `Facture en retard : ${clip(i.feeName, 150)}`,
    body: `L'échéance du ${formatDate(i.dueOn)} est passée. Il reste ${formatMoney(i.amountMinor, i.currency)} à payer.`,
    link: '/espace/paiements',
    dedupKey: `invoice.overdue:${invoiceId}`,
  }),

  paymentSucceeded: (amountMinor: number | string, currency: string, invoicePaid: boolean): NotificationMessage => ({
    kind: 'payment.succeeded',
    category: 'finance',
    title: `Paiement reçu : ${formatMoney(amountMinor, currency)}`,
    body: invoicePaid ? 'Votre facture est entièrement réglée.' : 'Le paiement a été enregistré sur votre facture.',
    link: '/espace/paiements',
  }),

  paymentFailed: (amountMinor: number | string, currency: string, reason: string): NotificationMessage => ({
    kind: 'payment.failed',
    category: 'finance',
    title: `Paiement non abouti : ${formatMoney(amountMinor, currency)}`,
    body: `Motif : ${clip(reason, 500)}. Vous pouvez réessayer depuis votre espace.`,
    link: '/espace/paiements',
  }),

  bankSlipToReview: (studentName: string, amountMinor: number | string, currency: string, bankName: string): NotificationMessage => ({
    kind: 'bank_payment.declared',
    category: 'tasks',
    title: `Bordereau à valider : ${clip(studentName, 120)}`,
    body: `${formatMoney(amountMinor, currency)} déposés chez ${clip(bankName, 100)}.`,
    link: '/espace/finances',
  }),

  bankSlipAccepted: (amountMinor: number | string, currency: string, invoicePaid: boolean): NotificationMessage => ({
    kind: 'bank_payment.accepted',
    category: 'finance',
    title: `Bordereau validé : ${formatMoney(amountMinor, currency)}`,
    body: invoicePaid ? 'Votre facture est entièrement réglée.' : 'Le paiement a été enregistré sur votre facture.',
    link: '/espace/paiements',
  }),

  bankSlipRejected: (amountMinor: number | string, currency: string, reason: string): NotificationMessage => ({
    kind: 'bank_payment.rejected',
    category: 'finance',
    title: `Bordereau refusé : ${formatMoney(amountMinor, currency)}`,
    body: `Motif : ${clip(reason, 500)}. Vous pouvez déposer un nouveau bordereau depuis votre espace.`,
    link: '/espace/paiements',
  }),

  gradesSubmitted: (course: string): NotificationMessage => ({
    kind: 'grades.submitted',
    category: 'tasks',
    title: `Notes à approuver : ${clip(course, 150)}`,
    body: 'Le professeur a soumis la feuille de notes.',
    link: '/espace/validation-notes',
  }),

  gradesApproved: (course: string): NotificationMessage => ({
    kind: 'grades.approved',
    category: 'tasks',
    title: `Notes à publier : ${clip(course, 150)}`,
    body: 'La feuille de notes a été approuvée et peut être publiée.',
    link: '/espace/validation-notes',
  }),

  gradesReturned: (offeringId: string, course: string, reason: string): NotificationMessage => ({
    kind: 'grades.returned',
    category: 'tasks',
    title: `Notes renvoyées : ${clip(course, 150)}`,
    body: `Motif : ${clip(reason, 500)}`,
    link: `/espace/notation/${offeringId}`,
  }),

  gradesPublished: (course: string): NotificationMessage => ({
    kind: 'grades.published',
    category: 'academic',
    title: `Notes publiées : ${clip(course, 150)}`,
    body: 'Votre note est disponible dans votre espace.',
    link: '/espace/notes',
  }),

  transcriptRequested: (studentName: string): NotificationMessage => ({
    kind: 'transcript.requested',
    category: 'tasks',
    title: `Relevé à valider : ${clip(studentName, 150)}`,
    body: 'Un étudiant demande un relevé de notes officiel.',
    link: '/espace/releves-validation',
  }),

  transcriptValidated: (): NotificationMessage => ({
    kind: 'transcript.validated',
    category: 'academic',
    title: 'Votre relevé officiel est prêt',
    body: 'Vous pouvez le télécharger en PDF depuis votre espace.',
    link: '/espace/notes',
  }),

  transcriptRejected: (reason: string): NotificationMessage => ({
    kind: 'transcript.rejected',
    category: 'academic',
    title: 'Demande de relevé refusée',
    body: `Motif : ${clip(reason, 500)}`,
    link: '/espace/notes',
  }),

  announcement: (announcementId: string, title: string, body: string): NotificationMessage => ({
    kind: 'announcement.published',
    category: 'announcements',
    title: clip(title, 200),
    body: clip(body, 600),
    link: '/espace',
    dedupKey: `announcement:${announcementId}`,
  }),
};
