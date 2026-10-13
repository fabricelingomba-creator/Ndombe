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
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Configuration invalide : ${details}`);
  }
  return parsed.data;
}

export const ENV = Symbol('ENV');
