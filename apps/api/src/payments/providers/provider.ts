import type { Currency } from '../money';

export const PROVIDER_KEYS = ['sandbox', 'stripe'] as const;
export type ProviderKey = (typeof PROVIDER_KEYS)[number];

export interface ChargeRequest {
  paymentId: string;
  tenantSlug: string;
  amountMinor: number;
  currency: Currency;
  description: string;
  /** Numéro Mobile Money (E.164), pour les prestataires qui envoient une demande au téléphone. */
  phone?: string;
  /** Page du portail où revenir après un paiement par carte. */
  returnUrl: string;
}

export interface ChargeResult {
  providerRef: string;
  /** Page de paiement hébergée par le prestataire (carte). */
  redirectUrl?: string;
  /** Consigne à afficher à l'étudiant (Mobile Money). */
  instructions?: string;
}

/** Notification d'un prestataire, traduite dans un format commun. */
export interface ProviderEvent {
  eventId: string;
  type: string;
  providerRef: string | null;
  /** Identifiant Elongo du paiement, quand le prestataire le renvoie (rattrape un webhook arrivé avant la référence). */
  paymentId?: string;
  outcome: 'succeeded' | 'failed' | 'ignored';
  amountMinor?: number;
  currency?: string;
  failureReason?: string;
}

export class InvalidSignatureError extends Error {}

/**
 * Contrat commun des prestataires de paiement. Ajouter un agrégateur
 * Mobile Money revient à implémenter ces trois méthodes ; le reste (factures,
 * idempotence, webhooks, audit) ne change pas.
 */
export interface PaymentProvider {
  readonly key: ProviderKey;
  readonly label: string;
  /** Le paiement demande un numéro de téléphone (Mobile Money). */
  readonly requiresPhone: boolean;
  /** Valide les secrets saisis par l'université ; peut en générer (secret de webhook). */
  prepareSecrets(input: Record<string, unknown>): Record<string, string>;
  createCharge(secrets: Record<string, string>, request: ChargeRequest): Promise<ChargeResult>;
  /** Vérifie la signature puis traduit l'événement ; lève InvalidSignatureError sinon. */
  parseWebhook(secrets: Record<string, string>, rawBody: Buffer, headers: Record<string, string | undefined>): ProviderEvent;
}

export const PAYMENT_FETCH = Symbol('PAYMENT_FETCH');
export type PaymentFetch = (input: string, init?: RequestInit) => Promise<Response>;
