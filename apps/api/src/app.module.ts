import { DynamicModule, MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { CatalogController, TermsController } from './academic/catalog.controller';
import { FacultiesController } from './academic/faculties.controller';
import { GradeSheetsController, MyAcademicsController } from './academic/my-academics.controller';
import { OfferingsController } from './academic/offerings.controller';
import { AuditController } from './audit/audit.controller';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { MeController } from './auth/me.controller';
import { BrandingController } from './branding/branding.controller';
import { ENV, Env, emailTransport } from './config/env';
import { AnnouncementsController } from './content/announcements.controller';
import { PublicHomepageController } from './content/public-homepage.controller';
import { DatabaseModule } from './db/database.module';
import { HealthController } from './health/health.controller';
import { KEYCLOAK_FETCH, KeycloakAdminService } from './keycloak/keycloak-admin.service';
import {
  BankAccountsController,
  BankPaymentsReviewController,
  MyBankPaymentsController,
} from './payments/bank-payments.controller';
import { EMAIL_TRANSPORT, LogEmailTransport, SmtpEmailTransport } from './notifications/email';
import { NotificationDispatcher } from './notifications/notification-dispatcher';
import { MyNotificationsController } from './notifications/notifications.controller';
import { NotificationsService } from './notifications/notifications.service';
import { MyPaymentsController, PaymentsAdminController, PaymentWebhooksController } from './payments/payments.controller';
import { PaymentsService } from './payments/payments.service';
import { PlatformController } from './platform/platform.controller';
import { TenantProvisioningService } from './platform/tenant-provisioning.service';
import { TenancyModule } from './tenancy/tenancy.module';
import {
  MyTranscriptsController,
  TranscriptsController,
  TranscriptVerificationController,
} from './transcripts/transcripts.controller';
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
        TermsController,
        CatalogController,
        OfferingsController,
        MyAcademicsController,
        GradeSheetsController,
        MyTranscriptsController,
        TranscriptsController,
        TranscriptVerificationController,
        AuditController,
        AnnouncementsController,
        PublicHomepageController,
        PaymentsAdminController,
        MyPaymentsController,
        PaymentWebhooksController,
        BankAccountsController,
        MyBankPaymentsController,
        BankPaymentsReviewController,
        MyNotificationsController,
        PlatformController,
      ],
      providers: [
        TenantProvisioningService,
        KeycloakAdminService,
        PaymentsService,
        NotificationsService,
        NotificationDispatcher,
        {
          provide: EMAIL_TRANSPORT,
          useFactory: () => {
            const kind = emailTransport(env);
            if (kind === 'smtp') return new SmtpEmailTransport(env.SMTP_URL!);
            return kind === 'log' ? new LogEmailTransport() : null;
          },
        },
        { provide: KEYCLOAK_FETCH, useValue: ((...args) => fetch(...args)) satisfies typeof fetch },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer) {
    // Toutes les routes appartiennent à une université, sauf la santé, le portail plateforme
    // et les webhooks de paiement (l'université y est désignée par l'URL, pas par l'hôte).
    consumer
      .apply(TenantMiddleware)
      .exclude(
        { path: 'health', method: RequestMethod.ALL },
        { path: 'platform/{*path}', method: RequestMethod.ALL },
        { path: 'webhooks/{*path}', method: RequestMethod.ALL },
      )
      .forRoutes('*');
  }
}
