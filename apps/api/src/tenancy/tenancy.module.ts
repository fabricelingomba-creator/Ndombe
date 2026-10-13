import { Global, Module } from '@nestjs/common';
import { TenantMiddleware } from './tenant.middleware';
import { TenantResolverService } from './tenant-resolver.service';

@Global()
@Module({
  providers: [TenantResolverService, TenantMiddleware],
  exports: [TenantResolverService, TenantMiddleware],
})
export class TenancyModule {}
