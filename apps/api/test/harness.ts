import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { Env, loadEnv } from '../src/config/env';
import { migrate } from '../src/db/migrate';
import { JWT_KEY_RESOLVER } from '../src/auth/jwt-verifier.service';
import { FetchLike, KEYCLOAK_FETCH } from '../src/keycloak/keycloak-admin.service';
import { configureApp } from '../src/main';

/**
 * Environnement de test : une base PostgreSQL neuve par suite, les vraies
 * migrations (RLS comprise), et une paire de clés locale à la place de Keycloak.
 * Les jetons portent le même émetteur qu'en production (KEYCLOAK_URL/realms/<realm>).
 */
export interface Harness {
  app: INestApplication;
  env: Env;
  dbName: string;
  /** Connexion superutilisateur, pour préparer ou altérer des données hors API. */
  admin: Pool;
  /** Connexion avec le rôle de l'API (elongo_app), soumise à la RLS. */
  appPool: Pool;
  token(realm: string, claims: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

const SERVER_URL = process.env.TEST_DATABASE_SERVER_URL ?? 'postgres://postgres:postgres@localhost:5432';
const APP_PASSWORD = 'elongo_app_test';
const PLATFORM_PASSWORD = 'elongo_platform_test';

function withDb(serverUrl: string, db: string, user?: string, password?: string) {
  const url = new URL(serverUrl);
  url.pathname = `/${db}`;
  if (user) {
    url.username = user;
    url.password = password ?? '';
  }
  return url.toString();
}

export interface HarnessOptions {
  env?: Record<string, string>;
  /** Remplace les appels HTTP vers l'API d'administration Keycloak. */
  keycloakFetch?: FetchLike;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dbName = `elongo_test_${randomBytes(4).toString('hex')}`;
  const server = new Client({ connectionString: withDb(SERVER_URL, 'postgres') });
  await server.connect();
  await server.query(`CREATE DATABASE ${dbName}`);
  await server.end();

  await migrate({
    ownerUrl: withDb(SERVER_URL, dbName),
    appPassword: APP_PASSWORD,
    platformPassword: PLATFORM_PASSWORD,
  });

  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: withDb(SERVER_URL, dbName, 'elongo_app', APP_PASSWORD),
    PLATFORM_DATABASE_URL: withDb(SERVER_URL, dbName, 'elongo_platform', PLATFORM_PASSWORD),
    KEYCLOAK_URL: 'https://auth.elongo.test',
    BASE_DOMAIN: 'elongo.test',
    TENANT_CACHE_TTL_MS: '0',
    PAYMENT_SECRETS_KEY: randomBytes(32).toString('base64'),
    PAYMENTS_SANDBOX: 'true',
    ...options.env,
  });

  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] })
    .overrideProvider(JWT_KEY_RESOLVER)
    .useValue(() => async () => publicKey)
    .overrideProvider(KEYCLOAK_FETCH)
    .useValue(
      options.keycloakFetch ??
        (async () => {
          throw new Error('Appel Keycloak inattendu dans un test');
        }),
    )
    .compile();
  const app = configureApp(moduleRef.createNestApplication({ logger: false, rawBody: true }), env);
  await app.init();

  const admin = new Pool({ connectionString: withDb(SERVER_URL, dbName) });
  const appPool = new Pool({ connectionString: env.DATABASE_URL });

  return {
    app,
    env,
    dbName,
    admin,
    appPool,
    async token(realm, claims) {
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
        .setIssuer(`${env.KEYCLOAK_URL}/realms/${realm}`)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
    },
    async close() {
      await app.close();
      await Promise.all([admin.end(), appPool.end()]);
      const s = new Client({ connectionString: withDb(SERVER_URL, 'postgres') });
      await s.connect();
      await s.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await s.end();
    },
  };
}
