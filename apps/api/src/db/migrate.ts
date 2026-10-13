import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

/**
 * Crée les rôles de connexion puis applique les migrations SQL dans l'ordre.
 * S'exécute avec un compte propriétaire (DATABASE_OWNER_URL), jamais avec elongo_app.
 */
export async function migrate(options: {
  ownerUrl: string;
  appPassword: string;
  platformPassword: string;
  migrationsDir?: string;
  log?: (msg: string) => void;
}) {
  const log = options.log ?? (() => undefined);
  const dir = options.migrationsDir ?? join(__dirname, '..', '..', 'migrations');
  const client = new Client({ connectionString: options.ownerUrl });
  await client.connect();
  try {
    await ensureLoginRole(client, 'elongo_app', options.appPassword);
    await ensureLoginRole(client, 'elongo_platform', options.platformPassword);

    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );

    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      log(`Migration ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Échec de la migration ${file} : ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}

async function ensureLoginRole(client: Client, role: string, password: string) {
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  const verb = exists.rowCount ? 'ALTER' : 'CREATE';
  // NOBYPASSRLS est explicite : ces rôles ne doivent jamais contourner l'isolation.
  await client.query(
    `${verb} ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${client.escapeLiteral(password)}`,
  );
}

if (require.main === module) {
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`Variable ${name} manquante`);
    return value;
  };
  migrate({
    ownerUrl: required('DATABASE_OWNER_URL'),
    appPassword: required('APP_DB_PASSWORD'),
    platformPassword: required('PLATFORM_DB_PASSWORD'),
    log: console.log,
  })
    .then(() => console.log('Migrations appliquées.'))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
