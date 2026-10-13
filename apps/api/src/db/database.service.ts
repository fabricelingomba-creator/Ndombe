import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { ENV, Env } from '../config/env';

export type Tx = PoolClient;

/**
 * Accès base de données. Toute requête sur des données d'université passe par
 * withTenant(), qui ouvre une transaction et fixe app.tenant_id : la RLS
 * PostgreSQL filtre alors chaque ligne, même si une requête oublie son WHERE.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly appPool: Pool;
  readonly platformPool: Pool;

  constructor(@Inject(ENV) env: Env) {
    this.appPool = new Pool({ connectionString: env.DATABASE_URL, max: 20 });
    this.platformPool = new Pool({ connectionString: env.PLATFORM_DATABASE_URL, max: 5 });
  }

  /** Lecture hors tenant (résolution du domaine) : seules les tables plateforme sont lisibles. */
  query<T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    return this.appPool.query<T>(sql, params);
  }

  withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.transaction(this.appPool, tenantId, fn);
  }

  /** Transaction du portail plateforme ; tenantId optionnel pour écrire dans un tenant donné. */
  withPlatform<T>(tenantId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.transaction(this.platformPool, tenantId, fn);
  }

  private async transaction<T>(pool: Pool, tenantId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (tenantId) {
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      }
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await Promise.all([this.appPool.end(), this.platformPool.end()]);
  }
}
