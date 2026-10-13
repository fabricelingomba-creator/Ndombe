import { DynamicModule, MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { FacultiesController } from './academic/faculties.controller';
import { AuditController } from './audit/audit.controller';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { MeController } from './auth/me.controller';
import { BrandingController } from './branding/branding.controller';
import { ENV, Env } from './config/env';
import { AnnouncementsController } from './content/announcements.controller';
import { PublicHomepageController } from './content/public-homepage.controller';
import { DatabaseModule } from './db/database.module';
import { HealthController } from './health/health.controller';
import { KEYCLOAK_FETCH, KeycloakAdminService } from './keycloak/keycloak-admin.service';
import { PlatformController } from './platform/platform.controller';
import { TenantProvisioningService } from './platform/tenant-provisioning.service';
import { TenancyModule } from './tenancy/tenancy.module';
import { TenantMiddleware } from './tenancy/tenant.middleware';

@Module({})
export class AppModule implements NestModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        { module: class EnvModule {}, global: true, providers: [{ provide: ENV, useValue: env }], exports: [ENV] },
        DatabaseModule,
        TenancyModule,
        AuthModule,
        AuditModule,
      ],
      controllers: [
        HealthController,
        BrandingController,
        MeController,
        FacultiesController,
        AuditController,
        AnnouncementsController,
        PublicHomepageController,
        PlatformController,
      ],
      providers: [
        TenantProvisioningService,
        KeycloakAdminService,
        { provide: KEYCLOAK_FETCH, useValue: ((...args) => fetch(...args)) satisfies typeof fetch },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer) {
    // Toutes les routes appartiennent à une université, sauf la santé et le portail plateforme.
    consumer
      .apply(TenantMiddleware)
      .exclude({ path: 'health', method: RequestMethod.ALL }, { path: 'platform/{*path}', method: RequestMethod.ALL })
      .forRoutes('*');
  }
}
