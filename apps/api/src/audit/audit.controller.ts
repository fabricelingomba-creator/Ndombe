import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query } from '@nestjs/common';
import { RequirePermission } from '../auth/decorators';
import { DatabaseService } from '../db/database.service';
import { CurrentTenant } from '../tenancy/current-tenant.decorator';
import { Tenant } from '../tenancy/tenant';
import { AuditService } from './audit.service';

@Controller('v1/audit-logs')
export class AuditController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('audit:read')
  list(@CurrentTenant() tenant: Tenant, @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number) {
    return this.db.withTenant(tenant.id, (tx) => this.audit.list(tx, Math.min(Math.max(limit, 1), 500)));
  }

  @Get('verify')
  @RequirePermission('audit:read')
  async verify(@CurrentTenant() tenant: Tenant) {
    const brokenAt = await this.db.withTenant(tenant.id, (tx) => this.audit.verifyChain(tx, tenant.id));
    return { intact: brokenAt === null, brokenAt };
  }
}
