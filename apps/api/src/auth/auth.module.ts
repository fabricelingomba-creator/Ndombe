import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RbacService } from '../rbac/rbac.service';
import { JWT_KEY_RESOLVER, JwtVerifierService, remoteJwksResolver } from './jwt-verifier.service';
import { PermissionsGuard } from './permissions.guard';
import { PlatformAdminGuard } from './platform-admin.guard';
import { TenantAuthGuard } from './tenant-auth.guard';

@Global()
@Module({
  providers: [
    { provide: JWT_KEY_RESOLVER, useFactory: remoteJwksResolver },
    JwtVerifierService,
    RbacService,
    PlatformAdminGuard,
    // Ordre : authentification, puis permissions. Toute route est protégée sauf @Public().
    { provide: APP_GUARD, useClass: TenantAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [JwtVerifierService, RbacService, PlatformAdminGuard],
})
export class AuthModule {}
