import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { loadEnv } from '../config/env';
import { TenantProvisioningService } from '../platform/tenant-provisioning.service';

/**
 * Crée l'université de démonstration « demo » (http://demo.elongo.localhost:3000)
 * dont le Recteur correspond à l'utilisateur du realm Keycloak univ-demo.
 */
async function seed() {
  const env = loadEnv();
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(env), { logger: ['error'] });
  try {
    const provisioning = app.get(TenantProvisioningService);
    const existing = (await provisioning.list()).find((t: { slug: string }) => t.slug === 'demo');
    if (existing) {
      console.log("L'université demo existe déjà.");
      return;
    }
    const tenant = await provisioning.provision(
      {
        slug: 'demo',
        name: 'Université de démonstration',
        plan: 'standard',
        defaultLocale: 'fr',
        customDomains: [],
        branding: { primaryColor: '#0B5394', secondaryColor: '#F1C232' },
        rector: { email: 'recteur@demo.elongo.localhost', fullName: 'Recteur Démo' },
      },
      'seed',
    );
    console.log(`Université demo créée : ${tenant.domains.join(', ')}`);
  } finally {
    await app.close();
  }
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
