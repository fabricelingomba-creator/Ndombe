import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { loadEnv, sandboxPaymentsEnabled } from '../config/env';
import { PaymentsService } from '../payments/payments.service';
import { TenantProvisioningService } from '../platform/tenant-provisioning.service';
import { DatabaseService, Tx } from './database.service';

/**
 * Crée l'université de démonstration « demo » (http://demo.elongo.localhost:3000)
 * dont le Recteur correspond à l'utilisateur du realm Keycloak univ-demo.
 */
async function seed() {
  const env = loadEnv();
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(env), { logger: ['error'] });
  try {
    const provisioning = app.get(TenantProvisioningService);
    let tenantId = (await provisioning.list()).find((t: { slug: string }) => t.slug === 'demo')?.id as string | undefined;
    if (tenantId) {
      console.log("L'université demo existe déjà.");
    } else {
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
      tenantId = tenant.id;
      console.log(`Université demo créée : ${tenant.domains.join(', ')}`);
    }
    const db = app.get(DatabaseService);
    await db.withPlatform(tenantId!, (tx) => seedAcademics(tx, tenantId!));
    await db.withPlatform(tenantId!, async (tx) => {
      await seedFees(tx, tenantId!);
      // Mobile Money simulé, si la clé de chiffrement est configurée (jamais en production).
      if (env.PAYMENT_SECRETS_KEY && sandboxPaymentsEnabled(env)) {
        const configured = await tx.query(`SELECT 1 FROM tenant_payment_providers WHERE provider = 'sandbox'`);
        if (!configured.rowCount) {
          await app.get(PaymentsService).configureProvider(tx, tenantId!, 'sandbox', {}, true);
          console.log('Paiement Mobile Money simulé activé.');
        }
      } else {
        console.log('PAYMENT_SECRETS_KEY absent : paiements en ligne non activés.');
      }
    });
  } finally {
    await app.close();
  }
}

/**
 * Données académiques de démonstration, une seule fois : une faculté, deux cours
 * et des comptes (SG académique, professeure, deux étudiants) qui correspondent
 * aux utilisateurs du realm Keycloak univ-demo. Ils se relient à la première
 * connexion par e-mail vérifié.
 */
async function seedAcademics(tx: Tx, tenantId: string) {
  const existing = await tx.query('SELECT 1 FROM faculties LIMIT 1');
  if (existing.rowCount) return;

  const one = async (sql: string, params: unknown[]) => (await tx.query<{ id: string }>(sql, params)).rows[0].id;
  const faculty = await one(
    `INSERT INTO faculties (tenant_id, code, name) VALUES ($1, 'SCI', 'Faculté des sciences') RETURNING id`,
    [tenantId],
  );
  const department = await one(
    `INSERT INTO departments (tenant_id, faculty_id, code, name) VALUES ($1, $2, 'INFO', 'Informatique') RETURNING id`,
    [tenantId, faculty],
  );
  const term = await one(
    `INSERT INTO academic_terms (tenant_id, code, name, starts_on, ends_on)
     VALUES ($1, '2026-S1', 'Premier semestre 2026-2027', '2026-09-01', '2027-01-31') RETURNING id`,
    [tenantId],
  );
  const offerings: string[] = [];
  for (const [code, title, credits] of [
    ['INF101', 'Algorithmique', 5],
    ['INF102', 'Bases de données', 4],
  ] as const) {
    const course = await one(
      `INSERT INTO courses (tenant_id, department_id, code, title, credits) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenantId, department, code, title, credits],
    );
    offerings.push(
      await one(
        `INSERT INTO course_offerings (tenant_id, course_id, term_id, capacity) VALUES ($1, $2, $3, 60) RETURNING id`,
        [tenantId, course, term],
      ),
    );
  }

  const user = async (email: string, fullName: string, role: string, scope: { type: string; id: string | null }) => {
    const id = await one(
      `INSERT INTO users (tenant_id, email, full_name) VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, email, fullName],
    );
    await tx.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id)
       SELECT $1, $2, id, $4, $5 FROM roles WHERE key = $3`,
      [tenantId, id, role, scope.type, scope.id],
    );
    return id;
  };
  await user('sg.academique@demo.elongo.localhost', 'SG Académique', 'sg_academic', { type: 'faculty', id: faculty });
  // La professeure enseigne les deux cours (portée « course » = une offre).
  const professor = await user('professeur@demo.elongo.localhost', 'Professeure Démo', 'professor', {
    type: 'course',
    id: offerings[0],
  });
  await tx.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id)
     SELECT $1, $2, id, 'course', $3 FROM roles WHERE key = 'professor'`,
    [tenantId, professor, offerings[1]],
  );
  for (const [email, name] of [
    ['etudiant@demo.elongo.localhost', 'Étudiant Démo'],
    ['etudiante@demo.elongo.localhost', 'Étudiante Démo'],
  ]) {
    const student = await user(email, name, 'student', { type: 'university', id: null });
    for (const offering of offerings) {
      await tx.query(`INSERT INTO enrollments (tenant_id, offering_id, student_user_id) VALUES ($1, $2, $3)`, [
        tenantId,
        offering,
        student,
      ]);
    }
  }
  console.log('Données académiques de démonstration créées (INF101, INF102).');
}

/** Deux frais de démonstration (dollars et francs congolais) facturés aux étudiants, une seule fois. */
async function seedFees(tx: Tx, tenantId: string) {
  const existing = await tx.query('SELECT 1 FROM fee_structures LIMIT 1');
  if (existing.rowCount) return;
  for (const [code, name, amountMinor, currency, dueOn] of [
    ['MIN-2026', 'Minerval 2026-2027 (1re tranche)', 25000, 'USD', '2026-11-30'],
    ['BIB-2026', 'Frais de bibliothèque', 2500000, 'CDF', '2026-12-15'],
  ] as const) {
    await tx.query(
      `WITH fee AS (
         INSERT INTO fee_structures (tenant_id, code, name, amount_minor, currency, due_on)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
       )
       INSERT INTO invoices (tenant_id, fee_structure_id, student_user_id, amount_minor, currency, due_on)
       SELECT fee.tenant_id, fee.id, u.id, fee.amount_minor, fee.currency, fee.due_on
         FROM fee, users u
        WHERE EXISTS (SELECT 1 FROM role_assignments ra JOIN role_permissions rp ON rp.role_id = ra.role_id
                       WHERE ra.user_id = u.id AND rp.permission = 'self:payments:write')`,
      [tenantId, code, name, amountMinor, currency, dueOn],
    );
  }
  console.log('Frais de démonstration facturés (MIN-2026, BIB-2026).');
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
