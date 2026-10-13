import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { ENV, Env } from '../config/env';
import { DatabaseService } from '../db/database.service';
import { SYSTEM_ROLES } from '../rbac/system-roles';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

export const provisionTenantSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  name: z.string().trim().min(2).max(200),
  plan: z.enum(['standard', 'premium']).default('standard'),
  defaultLocale: z.enum(['fr', 'en']).default('fr'),
  customDomains: z.array(z.string().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).default([]),
  branding: z
    .object({
      logoUrl: z.string().url().optional(),
      faviconUrl: z.string().url().optional(),
      primaryColor: hexColor.optional(),
      secondaryColor: hexColor.optional(),
    })
    .default({}),
  rector: z.object({
    email: z.string().email().toLowerCase(),
    fullName: z.string().trim().min(2).max(200),
  }),
});
export type ProvisionTenantInput = z.infer<typeof provisionTenantSchema>;

/**
 * Onboarding d'une université en une transaction : tenant, domaines, marque,
 * rôles système et compte du Recteur (invité). Le realm Keycloak correspondant
 * est nommé univ-<slug> ; sa création automatique arrive à l'étape suivante.
 */
@Injectable()
export class TenantProvisioningService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly resolver: TenantResolverService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async provision(input: ProvisionTenantInput, actorExternalId: string) {
    const result = await this.db.withPlatform(null, async (tx) => {
      const existing = await tx.query('SELECT 1 FROM tenants WHERE slug = $1', [input.slug]);
      if (existing.rowCount) throw new ConflictException(`Le slug ${input.slug} est déjà pris`);

      const tenant = (
        await tx.query<{ id: string; keycloak_realm: string }>(
          `INSERT INTO tenants (slug, name, plan, keycloak_realm, default_locale)
           VALUES ($1, $2, $3, $4, $5) RETURNING id, keycloak_realm`,
          [input.slug, input.name, input.plan, `univ-${input.slug}`, input.defaultLocale],
        )
      ).rows[0];

      const domains = [`${input.slug}.${this.env.BASE_DOMAIN}`, ...input.customDomains];
      for (const [i, domain] of domains.entries()) {
        await tx.query(
          // Le sous-domaine Elongo est vérifié d'office ; un domaine personnalisé attend sa vérification DNS.
          `INSERT INTO tenant_domains (tenant_id, domain, is_primary, verified_at)
           VALUES ($1, $2, $3, CASE WHEN $3 THEN now() END)`,
          [tenant.id, domain, i === 0],
        );
      }

      // À partir d'ici on écrit dans les tables de l'université : la RLS s'applique.
      await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.id]);

      await tx.query(
        `INSERT INTO tenant_branding (tenant_id, logo_url, favicon_url, primary_color, secondary_color)
         VALUES ($1, $2, $3, COALESCE($4, '#1D4ED8'), COALESCE($5, '#F59E0B'))`,
        [
          tenant.id,
          input.branding.logoUrl ?? null,
          input.branding.faviconUrl ?? null,
          input.branding.primaryColor ?? null,
          input.branding.secondaryColor ?? null,
        ],
      );

      const roleIds = new Map<string, string>();
      for (const role of SYSTEM_ROLES) {
        const roleId = (
          await tx.query<{ id: string }>(
            `INSERT INTO roles (tenant_id, key, name, is_system) VALUES ($1, $2, $3, true) RETURNING id`,
            [tenant.id, role.key, role.name],
          )
        ).rows[0].id;
        roleIds.set(role.key, roleId);
        await tx.query(
          `INSERT INTO role_permissions (tenant_id, role_id, permission) SELECT $1, $2, unnest($3::text[])`,
          [tenant.id, roleId, role.permissions],
        );
      }

      const rectorId = (
        await tx.query<{ id: string }>(
          `INSERT INTO users (tenant_id, email, full_name, status) VALUES ($1, $2, $3, 'invited') RETURNING id`,
          [tenant.id, input.rector.email, input.rector.fullName],
        )
      ).rows[0].id;
      await tx.query(
        `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type) VALUES ($1, $2, $3, 'university')`,
        [tenant.id, rectorId, roleIds.get('rector')],
      );

      await this.audit.record(tx, tenant.id, {
        actorUserId: null,
        action: 'tenant.provisioned',
        entityType: 'tenant',
        entityId: tenant.id,
        after: { slug: input.slug, name: input.name, plan: input.plan, domains, provisionedBy: actorExternalId },
      });

      return { id: tenant.id, slug: input.slug, keycloakRealm: tenant.keycloak_realm, domains, rectorUserId: rectorId };
    });
    this.resolver.invalidate();
    return result;
  }

  async list() {
    return this.db.withPlatform(null, async (tx) => {
      return (
        await tx.query(
          `SELECT t.id, t.slug, t.name, t.status, t.plan, t.created_at AS "createdAt",
                  s.users_total::int AS "usersTotal", s.users_active::int AS "usersActive",
                  s.faculties_total::int AS "facultiesTotal"
             FROM tenants t JOIN app.platform_tenant_stats() s ON s.tenant_id = t.id
            ORDER BY t.created_at`,
        )
      ).rows;
    });
  }
}
