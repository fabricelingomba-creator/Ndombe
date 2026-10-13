import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/decorators';
import { DatabaseService } from '../db/database.service';
import { CurrentTenant } from '../tenancy/current-tenant.decorator';
import { Tenant } from '../tenancy/tenant';
import { ANNOUNCEMENT_COLUMNS } from './announcements.controller';

/**
 * Contenu public de la page d'accueil d'une université, en un seul appel
 * pour limiter les allers-retours sur les connexions lentes.
 */
@Controller('v1/public/homepage')
@Public()
export class PublicHomepageController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  homepage(@CurrentTenant() tenant: Tenant) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const branding = (await tx.query<{ hero: Record<string, unknown> }>('SELECT hero FROM tenant_branding')).rows[0];
      const faculties = (
        await tx.query(`SELECT code, name FROM faculties WHERE deleted_at IS NULL ORDER BY name`)
      ).rows;
      const announcements = (
        await tx.query(
          `SELECT ${ANNOUNCEMENT_COLUMNS} FROM announcements
            WHERE visibility = 'public' AND deleted_at IS NULL AND published_at <= now()
            ORDER BY published_at DESC LIMIT 6`,
        )
      ).rows;
      return { hero: branding?.hero ?? {}, faculties, announcements };
    });
  }
}
