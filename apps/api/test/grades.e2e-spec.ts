import request from 'supertest';
import { createHarness, Harness } from './harness';

/**
 * Parcours complet d'une feuille de notes : catalogue, inscriptions, saisie,
 * soumission, renvoi, approbation (quatre yeux) et publication aux étudiants.
 */
describe('Cours, inscriptions et circuit des notes', () => {
  let h: Harness;
  let tenantId: string;
  let realm: string;
  const host = 'unig.elongo.test';
  const tokens: Record<string, string> = {};
  const users: Record<string, string> = {};
  let info: string; // département Informatique (faculté Sciences)
  let priv: string; // département Droit privé (faculté Droit)
  let term: string;
  let inf101: string;
  let inf102: string;
  let offering: string; // INF101-A, capacité 2
  let offering2: string; // INF102-A
  const enrollments: Record<string, string> = {};

  const api = () => request(h.app.getHttpServer());
  const as = (who: string) => ({ Host: host, Authorization: `Bearer ${tokens[who]}` });

  async function addUser(key: string, roleKey?: string, scope: { type: string; id: string | null } = { type: 'university', id: null }) {
    const email = `${key.toLowerCase()}@unig.cd`;
    const user = await h.admin.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, full_name, external_id, status) VALUES ($1, $2, $3, $2, 'active') RETURNING id`,
      [tenantId, email, key],
    );
    users[key] = user.rows[0].id;
    if (roleKey) {
      await h.admin.query(
        `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id)
         SELECT $1, $2, id, $4, $5 FROM roles WHERE tenant_id = $1 AND key = $3`,
        [tenantId, users[key], roleKey, scope.type, scope.id],
      );
    }
    tokens[key] = await h.token(realm, { sub: email });
  }

  beforeAll(async () => {
    h = await createHarness();
    const platformToken = await h.token('elongo-platform', { sub: 'ops', realm_access: { roles: ['platform-admin'] } });
    const res = await api()
      .post('/platform/tenants')
      .set('Authorization', `Bearer ${platformToken}`)
      .send({ slug: 'unig', name: 'Université G', rector: { email: 'recteur@unig.cd', fullName: 'Recteur G' } })
      .expect(201);
    tenantId = res.body.id;
    realm = res.body.keycloakRealm;
    tokens.rector = await h.token(realm, { sub: 'kc-rector', email: 'recteur@unig.cd', email_verified: true });

    const faculty = async (code: string) =>
      (await api().post('/v1/faculties').set(as('rector')).send({ code, name: code }).expect(201)).body.id as string;
    const department = async (facultyId: string, code: string) =>
      (await api().post(`/v1/faculties/${facultyId}/departments`).set(as('rector')).send({ code, name: code }).expect(201))
        .body.id as string;
    const sci = await faculty('SCI');
    const droit = await faculty('DROIT');
    info = await department(sci, 'INFO');
    priv = await department(droit, 'PRIV');

    await addUser('sgSci', 'sg_academic', { type: 'faculty', id: sci });
    await addUser('sgDroit', 'sg_academic', { type: 'faculty', id: droit });
    await addUser('prof');
    await addUser('autreProf');
    await addUser('etu1', 'student');
    await addUser('etu2', 'student');
    await addUser('etu3', 'student');
  });

  afterAll(async () => {
    await h?.close();
  });

  describe('Catalogue', () => {
    it('crée une période, des cours et leurs offres', async () => {
      term = (
        await api()
          .post('/v1/terms')
          .set(as('rector'))
          .send({ code: '2026-S1', name: 'Premier semestre 2026', startsOn: '2026-09-01', endsOn: '2027-01-31' })
          .expect(201)
      ).body.id;
      inf101 = (
        await api()
          .post(`/v1/departments/${info}/courses`)
          .set(as('sgSci'))
          .send({ code: 'INF101', title: 'Algorithmique', credits: 5 })
          .expect(201)
      ).body.id;
      inf102 = (
        await api()
          .post(`/v1/departments/${info}/courses`)
          .set(as('sgSci'))
          .send({ code: 'INF102', title: 'Bases de données', credits: 3 })
          .expect(201)
      ).body.id;
      offering = (
        await api()
          .post(`/v1/departments/${info}/offerings`)
          .set(as('sgSci'))
          .send({ courseId: inf101, termId: term, capacity: 2 })
          .expect(201)
      ).body.id;
      offering2 = (
        await api()
          .post(`/v1/departments/${info}/offerings`)
          .set(as('sgSci'))
          .send({ courseId: inf102, termId: term })
          .expect(201)
      ).body.id;

      const list = await api().get(`/v1/departments/${info}/offerings`).set(as('sgSci')).expect(200);
      expect(list.body.map((o: { courseCode: string }) => o.courseCode)).toEqual(['INF101', 'INF102']);
    });

    it('refuse une période dont la fin précède le début', async () => {
      await api()
        .post('/v1/terms')
        .set(as('rector'))
        .send({ code: 'X', name: 'X', startsOn: '2026-09-01', endsOn: '2026-08-01' })
        .expect(400);
    });

    it('un code de cours en double renvoie 409 et non 500', async () => {
      await api()
        .post(`/v1/departments/${info}/courses`)
        .set(as('sgSci'))
        .send({ code: 'INF101', title: 'Doublon', credits: 2 })
        .expect(409);
    });

    it("un SG d'une autre faculté ne touche pas au catalogue d'Informatique", async () => {
      await api()
        .post(`/v1/departments/${info}/courses`)
        .set(as('sgDroit'))
        .send({ code: 'INF999', title: 'Intrus', credits: 2 })
        .expect(403);
    });

    it("refuse d'ouvrir dans un département un cours qui ne lui appartient pas", async () => {
      await api()
        .post(`/v1/departments/${priv}/offerings`)
        .set(as('sgDroit'))
        .send({ courseId: inf101, termId: term, section: 'B' })
        .expect(404);
    });
  });

  describe('Enseignants et inscriptions', () => {
    it("attribue l'offre à un professeur, qui la voit dans ses enseignements", async () => {
      await api().post(`/v1/offerings/${offering}/instructors`).set(as('sgSci')).send({ userId: users.prof }).expect(204);
      // Idempotent.
      await api().post(`/v1/offerings/${offering}/instructors`).set(as('sgSci')).send({ userId: users.prof }).expect(204);
      const res = await api().get('/v1/me/teaching').set(as('prof')).expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ id: offering, courseCode: 'INF101', gradesStatus: 'draft' });
    });

    it('un professeur ou un SG de faculté lit les annonces et la structure du campus', async () => {
      for (const who of ['prof', 'sgSci']) {
        await api().get('/v1/announcements').set(as(who)).expect(200);
        await api().get('/v1/faculties').set(as(who)).expect(200);
        await api().get('/v1/terms').set(as(who)).expect(200);
      }
      // Sans la permission nulle part : refus.
      await api().get('/v1/faculties').set(as('autreProf')).expect(403);
    });

    it("refuse d'inscrire un compte qui n'est pas étudiant", async () => {
      await api().post(`/v1/offerings/${offering}/enrollments`).set(as('sgSci')).send({ userId: users.prof }).expect(422);
    });

    it('inscrit des étudiants dans la limite de la capacité', async () => {
      for (const key of ['etu1', 'etu2']) {
        const res = await api()
          .post(`/v1/offerings/${offering}/enrollments`)
          .set(as('sgSci'))
          .send({ userId: users[key] })
          .expect(201);
        enrollments[key] = res.body.id;
      }
      await api().post(`/v1/offerings/${offering}/enrollments`).set(as('sgSci')).send({ userId: users.etu3 }).expect(409);
      // Inscription en double.
      await api().post(`/v1/offerings/${offering2}/enrollments`).set(as('rector')).send({ userId: users.etu1 }).expect(201);
      await api().post(`/v1/offerings/${offering2}/enrollments`).set(as('rector')).send({ userId: users.etu1 }).expect(409);
    });

    it("l'étudiant voit ses cours, sans note avant publication", async () => {
      const courses = await api().get('/v1/me/courses').set(as('etu1')).expect(200);
      expect(courses.body.map((c: { courseCode: string }) => c.courseCode)).toEqual(['INF101', 'INF102']);
      expect(courses.body.every((c: { gradesPublished: boolean }) => !c.gradesPublished)).toBe(true);
      const grades = await api().get('/v1/me/grades').set(as('etu1')).expect(200);
      expect(grades.body).toEqual([]);
    });

    it("un étudiant ne voit pas la feuille de notes d'un cours", async () => {
      await api().get(`/v1/offerings/${offering}`).set(as('etu1')).expect(403);
    });
  });

  describe('Saisie et soumission', () => {
    it("un professeur non attribué ne saisit rien", async () => {
      await api()
        .put(`/v1/offerings/${offering}/grades`)
        .set(as('autreProf'))
        .send({ grades: [{ enrollmentId: enrollments.etu1, score: 20 }] })
        .expect(403);
    });

    it('refuse une note hors barème ou une inscription d’une autre offre', async () => {
      await api()
        .put(`/v1/offerings/${offering}/grades`)
        .set(as('prof'))
        .send({ grades: [{ enrollmentId: enrollments.etu1, score: 21 }] })
        .expect(400);
      const other = await h.admin.query<{ id: string }>('SELECT id FROM enrollments WHERE offering_id = $1', [offering2]);
      await api()
        .put(`/v1/offerings/${offering}/grades`)
        .set(as('prof'))
        .send({ grades: [{ enrollmentId: other.rows[0].id, score: 12 }] })
        .expect(404);
    });

    it('ne soumet pas une feuille incomplète', async () => {
      await api()
        .put(`/v1/offerings/${offering}/grades`)
        .set(as('prof'))
        .send({ grades: [{ enrollmentId: enrollments.etu1, score: 14.75 }] })
        .expect(200, { updated: 1 });
      const res = await api().post(`/v1/offerings/${offering}/grades/submit`).set(as('prof')).expect(422);
      expect(res.body.message).toMatch(/1 note\(s\) manquante/);
    });

    it('soumet une feuille complète puis la verrouille', async () => {
      await api()
        .put(`/v1/offerings/${offering}/grades`)
        .set(as('prof'))
        .send({
          grades: [
            { enrollmentId: enrollments.etu1, score: 14.75 },
            { enrollmentId: enrollments.etu2, score: 8.5 },
          ],
        })
        .expect(200, { updated: 1 });
      await api()
        .post(`/v1/offerings/${offering}/grades/submit`)
        .set(as('prof'))
        .expect(200, { id: offering, gradesStatus: 'submitted' });

      await api()
        .put(`/v1/offerings/${offering}/grades`)
        .set(as('prof'))
        .send({ grades: [{ enrollmentId: enrollments.etu2, score: 10 }] })
        .expect(409);
      await api().post(`/v1/offerings/${offering}/enrollments`).set(as('sgSci')).send({ userId: users.etu3 }).expect(409);
    });

    it('la base refuse elle aussi de modifier une note soumise', async () => {
      const client = await h.appPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
        await expect(client.query('UPDATE grades SET score = 20')).rejects.toThrow(/verrouillée/);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });
  });

  describe('Validation par le SG académique', () => {
    it('la file de validation respecte la portée du SG', async () => {
      const sci = await api().get('/v1/grade-sheets?status=submitted').set(as('sgSci')).expect(200);
      expect(sci.body.map((s: { id: string }) => s.id)).toEqual([offering]);
      const droit = await api().get('/v1/grade-sheets?status=submitted').set(as('sgDroit')).expect(200);
      expect(droit.body).toEqual([]);
      await api().get('/v1/grade-sheets?status=submitted').set(as('prof')).expect(403);
    });

    it("un SG d'une autre faculté ne peut ni approuver ni renvoyer", async () => {
      await api().post(`/v1/offerings/${offering}/grades/approve`).set(as('sgDroit')).expect(403);
    });

    it('renvoie la feuille avec un motif, que le professeur voit', async () => {
      await api().post(`/v1/offerings/${offering}/grades/return`).set(as('sgSci')).send({ reason: '' }).expect(400);
      await api()
        .post(`/v1/offerings/${offering}/grades/return`)
        .set(as('sgSci'))
        .send({ reason: 'Vérifier la note de etu2' })
        .expect(200, { id: offering, gradesStatus: 'returned' });
      const res = await api().get('/v1/me/teaching').set(as('prof')).expect(200);
      expect(res.body[0]).toMatchObject({ gradesStatus: 'returned', returnReason: 'Vérifier la note de etu2' });
    });

    it('le professeur corrige et soumet à nouveau', async () => {
      await api()
        .put(`/v1/offerings/${offering}/grades`)
        .set(as('prof'))
        .send({ grades: [{ enrollmentId: enrollments.etu2, score: 12.35 }] })
        .expect(200, { updated: 1 });
      await api().post(`/v1/offerings/${offering}/grades/submit`).set(as('prof')).expect(200);
      const sheet = await api().get(`/v1/offerings/${offering}`).set(as('prof')).expect(200);
      expect(sheet.body).toMatchObject({ gradesStatus: 'submitted', returnReason: null });
      expect(sheet.body.instructors.map((i: { id: string }) => i.id)).toEqual([users.prof]);
      expect(sheet.body.roster.map((r: { score: number }) => r.score)).toEqual([14.75, 12.35]);
    });

    it('ne publie pas une feuille non approuvée', async () => {
      await api().post(`/v1/offerings/${offering}/grades/publish`).set(as('sgSci')).expect(409);
    });

    it('approuve puis publie', async () => {
      await api().post(`/v1/offerings/${offering}/grades/approve`).set(as('sgSci')).expect(200, {
        id: offering,
        gradesStatus: 'approved',
      });
      const toPublish = await api().get('/v1/grade-sheets?status=approved').set(as('sgSci')).expect(200);
      expect(toPublish.body.map((s: { id: string }) => s.id)).toEqual([offering]);
      await api().post(`/v1/offerings/${offering}/grades/publish`).set(as('sgSci')).expect(200, {
        id: offering,
        gradesStatus: 'published',
      });
    });

    it('chaque étape prévient la bonne personne, dans sa portée', async () => {
      const rector = (await h.admin.query<{ id: string }>(`SELECT id FROM users WHERE email = 'recteur@unig.cd'`)).rows[0].id;
      const received = async (kind: string) =>
        (
          await h.admin.query<{ user_id: string }>('SELECT user_id FROM notifications WHERE kind = $1 ORDER BY user_id', [kind])
        ).rows.map((r) => r.user_id);
      // Deux soumissions : le SG de la faculté et le recteur, jamais le SG d'une autre faculté.
      expect(await received('grades.submitted')).toEqual([rector, rector, users.sgSci, users.sgSci].sort());
      expect(await received('grades.returned')).toEqual([users.prof]);
      // Approuvée par le SG : le recteur peut publier.
      expect(await received('grades.approved')).toEqual([rector]);
      expect(await received('grades.published')).toEqual([users.etu1, users.etu2].sort());
      const returned = await h.admin.query(`SELECT title, body, link FROM notifications WHERE kind = 'grades.returned'`);
      expect(returned.rows[0]).toEqual({
        title: expect.stringContaining('Notes renvoyées : INF101'),
        body: 'Motif : Vérifier la note de etu2',
        link: `/espace/notation/${offering}`,
      });
    });

    it("on n'approuve pas sa propre feuille (quatre yeux)", async () => {
      await api()
        .put(`/v1/offerings/${offering2}/grades`)
        .set(as('rector'))
        .send({ grades: [{ enrollmentId: (await enrollmentOf(offering2, 'etu1')), score: 11 }] })
        .expect(200);
      await api().post(`/v1/offerings/${offering2}/grades/submit`).set(as('rector')).expect(200);
      await api().post(`/v1/offerings/${offering2}/grades/approve`).set(as('rector')).expect(403);
      await api().post(`/v1/offerings/${offering2}/grades/approve`).set(as('sgSci')).expect(200);
    });
  });

  describe("Côté étudiant", () => {
    it('ne voit que les notes publiées, avec moyenne pondérée et crédits', async () => {
      const res = await api().get('/v1/me/grades').set(as('etu1')).expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({
        termCode: '2026-S1',
        average: 14.75,
        creditsAttempted: 5,
        creditsEarned: 5,
      });
      // INF102 est approuvée mais pas publiée.
      expect(res.body[0].grades.map((g: { courseCode: string }) => g.courseCode)).toEqual(['INF101']);
    });

    it("chaque étudiant ne voit que ses propres notes", async () => {
      const res = await api().get('/v1/me/grades').set(as('etu2')).expect(200);
      expect(res.body[0].grades).toEqual([expect.objectContaining({ courseCode: 'INF101', score: 12.35 })]);
    });
  });

  it("une autre université ne voit ni l'offre ni ses notes", async () => {
    const platformToken = await h.token('elongo-platform', { sub: 'ops', realm_access: { roles: ['platform-admin'] } });
    const other = await api()
      .post('/platform/tenants')
      .set('Authorization', `Bearer ${platformToken}`)
      .send({ slug: 'unih', name: 'Université H', rector: { email: 'recteur@unih.cd', fullName: 'Recteur H' } })
      .expect(201);
    const otherRector = await h.token(other.body.keycloakRealm, { sub: 'kc-h', email: 'recteur@unih.cd', email_verified: true });
    const headers = { Host: 'unih.elongo.test', Authorization: `Bearer ${otherRector}` };
    await api().get(`/v1/offerings/${offering}`).set(headers).expect(404);
    await api().post(`/v1/offerings/${offering}/grades/publish`).set(headers).expect(404);
    const sheets = await api().get('/v1/grade-sheets?status=approved').set(headers).expect(200);
    expect(sheets.body).toEqual([]);
  });

  it("chaque étape est tracée dans le journal d'audit, chaîne intacte", async () => {
    const res = await api().get('/v1/audit-logs?limit=100').set(as('rector')).expect(200);
    const actions = res.body.map((e: { action: string }) => e.action);
    for (const a of ['grades.entered', 'grades.submitted', 'grades.returned', 'grades.approved', 'grades.published', 'enrollment.created']) {
      expect(actions).toContain(a);
    }
    await api().get('/v1/audit-logs/verify').set(as('rector')).expect(200, { intact: true, brokenAt: null });
  });

  async function enrollmentOf(offeringId: string, student: string) {
    const res = await h.admin.query<{ id: string }>(
      'SELECT id FROM enrollments WHERE offering_id = $1 AND student_user_id = $2',
      [offeringId, users[student]],
    );
    return res.rows[0].id;
  }
});
