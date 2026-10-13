import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/decorators';
import { JwtVerifierService } from '../auth/jwt-verifier.service';
import { DatabaseService } from '../db/database.service';
import { CurrentTenant } from '../tenancy/current-tenant.decorator';
import { Tenant } from '../tenancy/tenant';

/**
 * Manifeste public d'une université : ce que le site et l'app mobile chargent
 * au démarrage pour s'habiller aux couleurs de l'établissement.
 */
@Controller('v1/tenant')
export class BrandingController {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtVerifierService,
  ) {}

  @Get('manifest')
  @Public()
  async manifest(@CurrentTenant() tenant: Tenant) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const branding = (
        await tx.query(
          `SELECT logo_url AS "logoUrl", favicon_url AS "faviconUrl", primary_color AS "primaryColor",
                  secondary_color AS "secondaryColor", hero
             FROM tenant_branding`,
        )
      ).rows[0];
      const features = (await tx.query<{ key: string }>('SELECT key FROM feature_flags WHERE enabled ORDER BY key')).rows;
      return {
        slug: tenant.slug,
        name: tenant.name,
        locale: tenant.defaultLocale,
        branding: branding ?? null,
        features: features.map((f) => f.key),
        auth: { issuer: this.jwt.issuerFor(tenant.keycloakRealm) },
      };
    });
  }
}
