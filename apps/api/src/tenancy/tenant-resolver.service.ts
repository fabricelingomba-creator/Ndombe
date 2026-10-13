import { Inject, Injectable } from '@nestjs/common';
import { ENV, Env } from '../config/env';
import { DatabaseService } from '../db/database.service';
import { Tenant } from './tenant';

interface CacheEntry {
  tenant: Tenant | null;
  expiresAt: number;
}

const TENANT_COLUMNS = `t.id, t.slug, t.name, t.status, t.plan,
  t.keycloak_realm AS "keycloakRealm", t.default_locale AS "defaultLocale"`;

/**
 * Trouve l'université d'une requête à partir du nom d'hôte :
 *   1. un domaine enregistré dans tenant_domains (portail.unikin.ac.cd) ;
 *   2. un sous-domaine du domaine racine (unikin.elongo.app).
 * Les résultats, y compris les échecs, sont mis en cache quelques secondes.
 */
@Injectable()
export class TenantResolverService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly db: DatabaseService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async resolveHost(rawHost: string): Promise<Tenant | null> {
    const host = rawHost.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    return this.cached(`host:${host}`, async () => {
      const byDomain = await this.db.query<Tenant>(
        `SELECT ${TENANT_COLUMNS} FROM tenant_domains d JOIN tenants t ON t.id = d.tenant_id WHERE d.domain = $1`,
        [host],
      );
      if (byDomain.rows[0]) return byDomain.rows[0];

      const suffix = `.${this.env.BASE_DOMAIN}`;
      if (!host.endsWith(suffix)) return null;
      const slug = host.slice(0, -suffix.length);
      if (!slug || slug.includes('.')) return null;
      return this.resolveSlug(slug);
    });
  }

  /** Utilisé par l'app mobile, qui envoie l'identifiant de l'université choisie. */
  async resolveSlug(slug: string): Promise<Tenant | null> {
    return this.cached(`slug:${slug}`, async () => {
      const res = await this.db.query<Tenant>(`SELECT ${TENANT_COLUMNS} FROM tenants t WHERE t.slug = $1`, [slug]);
      return res.rows[0] ?? null;
    });
  }

  invalidate() {
    this.cache.clear();
  }

  private async cached(key: string, load: () => Promise<Tenant | null>): Promise<Tenant | null> {
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) return hit.tenant;
    const tenant = await load();
    this.cache.set(key, { tenant, expiresAt: now + this.env.TENANT_CACHE_TTL_MS });
    return tenant;
  }
}
