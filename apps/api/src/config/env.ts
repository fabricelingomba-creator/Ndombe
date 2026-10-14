import { z } from 'zod';

/** Une variable présente mais vide (KEY= dans un .env) vaut « non définie ». */
const optionalString = z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  /** Connexion de l'API des universités (rôle elongo_app, soumis à la RLS). */
  DATABASE_URL: z.string().url(),
  /** Connexion du portail plateforme (rôle elongo_platform). */
  PLATFORM_DATABASE_URL: z.string().url(),
  /** URL publique de Keycloak, par exemple https://auth.elongo.app */
  KEYCLOAK_URL: z.string().url(),
  /** Realm Keycloak des administrateurs de la plateforme. */
  PLATFORM_REALM: z.string().min(1).default('elongo-platform'),
  /** Domaine racine : <slug>.<BASE_DOMAIN> est le portail d'une université. */
  BASE_DOMAIN: z.string().min(1).default('elongo.localhost'),
  /** Nombre de proxys de confiance devant l'API (Cloudflare, ingress). */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  TENANT_CACHE_TTL_MS: z.coerce.number().int().min(0).default(60_000),
  /**
   * Client de service Keycloak (realm master, client credentials) qui crée les
   * realms des universités. Sans lui, l'onboarding n'écrit que la base.
   */
  KEYCLOAK_ADMIN_CLIENT_ID: optionalString,
  KEYCLOAK_ADMIN_CLIENT_SECRET: optionalString,
  /**
   * Clé AES-256 (32 octets en base64) qui chiffre les secrets des prestataires
   * de paiement de chaque université. Sans elle, les paiements sont désactivés.
   */
  PAYMENT_SECRETS_KEY: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'doit contenir 32 octets encodés en base64')
      .optional(),
  ),
  /** Prestataire « sandbox » (Mobile Money simulé) : jamais en production. */
  PAYMENTS_SANDBOX: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['true', 'false']).optional()),
  /**
   * Envoi des e-mails de notification : smtp (production), log (journal, développement)
   * ou none (aucun e-mail). Par défaut : log hors production, none en production.
   */
  EMAIL_TRANSPORT: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['none', 'log', 'smtp']).optional()),
  /** smtps://utilisateur:motdepasse@smtp.exemple.com:465 (Brevo, Mailgun, SES, Postmark…). */
  SMTP_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  /** Adresse d'expédition ; le nom affiché est celui de l'université. */
  EMAIL_FROM: z.preprocess((v) => (v === '' ? undefined : v), z.email().optional()),
  /** Fréquence d'envoi des notifications en attente ; 0 désactive la boucle (tests). */
  NOTIFICATIONS_INTERVAL_MS: z.coerce.number().int().min(0).default(15_000),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Configuration invalide : ${details}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && env.PAYMENTS_SANDBOX === 'true') {
    throw new Error('Configuration invalide : PAYMENTS_SANDBOX interdit en production');
  }
  const transport = emailTransport(env);
  if (env.NODE_ENV === 'production' && transport === 'log') {
    throw new Error('Configuration invalide : EMAIL_TRANSPORT=log interdit en production (données personnelles dans les journaux)');
  }
  if (transport === 'smtp' && !env.SMTP_URL) {
    throw new Error('Configuration invalide : SMTP_URL requis quand EMAIL_TRANSPORT=smtp');
  }
  return env;
}

export function emailTransport(env: Env): 'none' | 'log' | 'smtp' {
  return env.EMAIL_TRANSPORT ?? (env.NODE_ENV === 'production' ? 'none' : 'log');
}

export function emailFrom(env: Env): string {
  return env.EMAIL_FROM ?? `no-reply@${env.BASE_DOMAIN}`;
}

/** Le prestataire simulé est actif hors production, sauf désactivation explicite. */
export function sandboxPaymentsEnabled(env: Env): boolean {
  return env.NODE_ENV !== 'production' && env.PAYMENTS_SANDBOX !== 'false';
}

export const ENV = Symbol('ENV');
