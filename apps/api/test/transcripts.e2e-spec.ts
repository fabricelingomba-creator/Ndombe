import request from 'supertest';
import { snapshotHash, TranscriptSnapshot } from '../src/transcripts/transcript';
import { createHarness, Harness } from './harness';

/** Relevé officiel : demande, refus, validation, PDF et vérification publique. */
describe('Relevés de notes officiels', () => {
  let h: Harness;
  let tenantId: string;
  let realm: string;
  const host = 'unir.elongo.test';
  const tokens: Record<string, string> = {};
  const users: Record<string, string> = {};
  let transcriptId: string;
  let code: string;

  const api = () => request(h.app.getHttpServer());
  const as = (who: string) => ({ Host: host, Authorization: `Bearer ${tokens[who]}` });

  async function addUser(key: string, roleKey: string) {
    const email = `${key}@unir.cd`;
    const user = await h.admin.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, full_name, external_id, status) VALUES ($1, $2, $3, $2, 'active') RETURNING id`,
      [tenantId, email, `Nom ${key}`],
    );
    users[key] = user.rows[0].id;
    await h.admin.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type)
       SELECT $1, $2, id, 'university' FROM roles WHERE tenant_id = $1 AND key = $3`,
      [tenantId, users[key], roleKey],
    );
    tokens[key] = await h.token(realm, { sub: email });
  }

  /** Une offre publiée avec une note pour l'étudiant donné. */
  async function publishedGrade(courseCode: string, credits: number, scores: Record<string, number>) {
    const one = async (sql: string, params: unknown[]) => (await h.admin.query<{ id: string }>(sql, params)).rows[0].id;
    const dept = await one(`SELECT id FROM departments WHERE tenant_id = $1 LIMIT 1`, [tenantId]);
    const term = await one(`SELECT id FROM academic_terms WHERE tenant_id = $1 LIMIT 1`, [tenantId]);
    const course = await one(
      `INSERT INTO courses (tenant_id, department_id, code, title, credits) VALUES ($1, $2, $3, $3, $4) RETURNING id`,
      [tenantId, dept, courseCode, credits],
    );
    const offering = await one(
      `INSERT INTO course_offerings (tenant_id, course_id, term_id) VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, course, term],
    );
    for (const [student, score] of Object.entries(scores)) {
      const enrollment = await one(
        `INSERT INTO enrollments (tenant_id, offering_id, student_user_id) VALUES ($1, $2, $3) RETURNING id`,
        [tenantId, offering, users[student]],
      );
      await h.admin.query(`INSERT INTO grades (enrollment_id, tenant_id, score, entered_by) VALUES ($1, $2, $3, $4)`, [
        enrollment,
        tenantId,
        score,
        users.sg,
      ]);
    }
    await h.admin.query(
      `UPDATE course_offerings SET grades_status = 'published', grades_published_at = now() WHERE id = $1`,
      [offering],
    );
  }

  beforeAll(async () => {
    h = await createHarness();
    const platformToken = await h.token('elongo-platform', { sub: 'ops', realm_access: { roles: ['platform-admin'] } });
    const res = await api()
      .post('/platform/tenants')
      .set('Authorization', `Bearer ${platformToken}`)
      .send({ slug: 'unir', name: 'Université R', rector: { email: 'recteur@unir.cd', fullName: 'Recteur R' } })
      .expect(201);
    tenantId = res.body.id;
    realm = res.body.keycloakRealm;

    await addUser('sg', 'sg_academic');
    await addUser('etu', 'student');
    await addUser('autre', 'student');
    const faculty = await h.admin.query<{ id: string }>(
      `INSERT INTO faculties (tenant_id, code, name) VALUES ($1, 'SCI', 'Sciences') RETURNING id`,
      [tenantId],
    );
    await h.admin.query(`INSERT INTO departments (tenant_id, faculty_id, code, name) VALUES ($1, $2, 'INFO', 'Info')`, [
      tenantId,
      faculty.rows[0].id,
    ]);
    await h.admin.query(
      `INSERT INTO academic_terms (tenant_id, code, name, starts_on, ends_on)
       VALUES ($1, '2026-S1', 'Semestre 1', '2026-09-01', '2027-01-31')`,
      [tenantId],
    );
  });

  afterAll(async () => {
    await h?.close();
  });

  it("refuse une demande tant qu'aucune note n'est publiée", async () => {
    await api().post('/v1/me/transcripts').set(as('etu')).expect(422);
  });

  it("l'étudiant demande un relevé, une seule demande à la fois", async () => {
    await publishedGrade('INF101', 5, { etu: 14, autre: 9 });
    await publishedGrade('INF102', 3, { etu: 8 });
    const res = await api().post('/v1/me/transcripts').set(as('etu')).expect(201);
    expect(res.body).toMatchObject({ status: 'requested', verificationCode: null });
    transcriptId = res.body.id;
    await api().post('/v1/me/transcripts').set(as('etu')).expect(409);
  });

  it("un étudiant ne traite pas les demandes et ne télécharge pas un relevé non validé", async () => {
    await api().get('/v1/transcripts').set(as('etu')).expect(403);
    await api().post(`/v1/transcripts/${transcriptId}/validate`).set(as('etu')).expect(403);
    await api().get(`/v1/me/transcripts/${transcriptId}/pdf`).set(as('etu')).expect(404);
  });

  it('le SG refuse avec un motif, que l’étudiant voit, puis l’étudiant redemande', async () => {
    const queue = await api().get('/v1/transcripts').set(as('sg')).expect(200);
    expect(queue.body).toEqual([expect.objectContaining({ id: transcriptId, studentName: 'Nom etu' })]);
    await api().post(`/v1/transcripts/${transcriptId}/reject`).set(as('sg')).send({ reason: '' }).expect(400);
    await api()
      .post(`/v1/transcripts/${transcriptId}/reject`)
      .set(as('sg'))
      .send({ reason: 'Frais de scolarité impayés' })
      .expect(200);
    const mine = await api().get('/v1/me/transcripts').set(as('etu')).expect(200);
    expect(mine.body[0]).toMatchObject({ status: 'rejected', rejectReason: 'Frais de scolarité impayés' });
    await api().post(`/v1/transcripts/${transcriptId}/validate`).set(as('sg')).expect(409);

    transcriptId = (await api().post('/v1/me/transcripts').set(as('etu')).expect(201)).body.id;
  });

  it('le SG valide : les notes publiées sont figées et signées par leur empreinte', async () => {
    const res = await api().post(`/v1/transcripts/${transcriptId}/validate`).set(as('sg')).expect(200);
    code = res.body.verificationCode;
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);

    const stored = await h.admin.query<{ snapshot: TranscriptSnapshot; content_hash: string }>(
      'SELECT snapshot, content_hash FROM transcripts WHERE id = $1',
      [transcriptId],
    );
    const { snapshot, content_hash } = stored.rows[0];
    expect(snapshotHash(snapshot)).toBe(content_hash);
    expect(res.body.contentHash).toBe(content_hash);
    // (14 × 5 + 8 × 3) / 8 = 11,75 ; INF102 n'est pas validé.
    expect(snapshot.summary).toEqual({ average: 11.75, creditsAttempted: 8, creditsEarned: 5 });
    expect(snapshot.student.fullName).toBe('Nom etu');
    expect(snapshot.verifyUrl).toBe('https://unir.elongo.test/verifier');
  });

  it("l'étudiant télécharge le PDF ; un autre étudiant ne le peut pas", async () => {
    const res = await api()
      .get(`/v1/me/transcripts/${transcriptId}/pdf`)
      .set(as('etu'))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain(`releve-${code}.pdf`);
    const pdf = res.body as Buffer;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(2000);

    await api().get(`/v1/me/transcripts/${transcriptId}/pdf`).set(as('autre')).expect(404);
    await api().get(`/v1/transcripts/${transcriptId}/pdf`).set(as('sg')).expect(200);
  });

  it('un relevé validé ne peut plus être modifié, même en base', async () => {
    const client = await h.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      await expect(client.query(`UPDATE transcripts SET content_hash = 'faux'`)).rejects.toThrow(/déjà traité/);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  describe('Vérification publique', () => {
    it('reconnaît un code, même saisi en minuscules sans tirets, sans connexion', async () => {
      const res = await api()
        .get(`/v1/public/transcripts/verify/${code.replaceAll('-', '').toLowerCase()}`)
        .set('Host', host)
        .expect(200);
      expect(res.body).toMatchObject({
        valid: true,
        university: 'Université R',
        verificationCode: code,
        studentName: 'Nom etu',
        creditsEarned: 5,
        average: 11.75,
      });
      expect(res.body).not.toHaveProperty('snapshot');
    });

    it('rejette un code inconnu ou mal formé', async () => {
      await api().get('/v1/public/transcripts/verify/AAAA-BBBB-CCCC').set('Host', host).expect(404);
      await api().get('/v1/public/transcripts/verify/pas-un-code').set('Host', host).expect(404);
    });

    it("ne vérifie pas le relevé d'une autre université", async () => {
      const platformToken = await h.token('elongo-platform', { sub: 'ops', realm_access: { roles: ['platform-admin'] } });
      await api()
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${platformToken}`)
        .send({ slug: 'unis', name: 'Université S', rector: { email: 'recteur@unis.cd', fullName: 'Recteur S' } })
        .expect(201);
      await api().get(`/v1/public/transcripts/verify/${code}`).set('Host', 'unis.elongo.test').expect(404);
    });

    it("l'API ne lit pas les relevés sans université, hors fonction de vérification", async () => {
      const res = await h.appPool.query('SELECT count(*)::int AS n FROM transcripts');
      expect(res.rows[0].n).toBe(0);
    });
  });

  it("chaque décision est tracée dans le journal d'audit, chaîne intacte", async () => {
    const rector = await h.token(realm, { sub: 'kc-r', email: 'recteur@unir.cd', email_verified: true });
    const headers = { Host: host, Authorization: `Bearer ${rector}` };
    const res = await api().get('/v1/audit-logs').set(headers).expect(200);
    const actions = res.body.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['transcript.requested', 'transcript.rejected', 'transcript.validated']));
    await api().get('/v1/audit-logs/verify').set(headers).expect(200, { intact: true, brokenAt: null });
  });
});
