import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/decorators';
import { PlatformAdminGuard } from '../auth/platform-admin.guard';
import { ZodPipe } from '../common/zod.pipe';
import { ProvisionTenantInput, provisionTenantSchema, TenantProvisioningService } from './tenant-provisioning.service';

/**
 * Portail Super Admin. @Public() désactive l'authentification des universités ;
 * PlatformAdminGuard impose à la place un jeton du realm plateforme.
 */
@Controller('platform/tenants')
@Public()
@UseGuards(PlatformAdminGuard)
export class PlatformController {
  constructor(private readonly provisioning: TenantProvisioningService) {}

  @Get()
  list() {
    return this.provisioning.list();
  }

  @Post()
  create(@Body(new ZodPipe(provisionTenantSchema)) body: ProvisionTenantInput, @Req() req: Request) {
    return this.provisioning.provision(body, req.platformAdmin!.externalId);
  }
}
