-- Phase 1 : catalogue des cours, sessions (offres d'un cours sur une période),
-- inscriptions et notes avec leur circuit de validation.
--
--   courses           : le cours au catalogue, rattaché à un département.
--   academic_terms    : semestres ou années (2026-S1…).
--   course_offerings  : un cours donné pendant une période, dans une section.
--                       C'est la portée « course » du RBAC : un professeur
--                       reçoit le rôle professor sur une offre précise.
--   enrollments       : un étudiant inscrit à une offre.
--   grades            : la note d'une inscription, sur 20.
--
-- Circuit d'une feuille de notes (portée par l'offre) :
--   draft → submitted → approved → published
--             └→ returned → submitted …
-- Les notes ne sont modifiables qu'en draft ou returned.

ALTER TABLE departments ADD CONSTRAINT departments_tenant_id_id_key UNIQUE (tenant_id, id);

CREATE TABLE academic_terms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        text NOT NULL CHECK (length(code) BETWEEN 1 AND 32),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  starts_on   date NOT NULL,
  ends_on     date NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on > starts_on),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

CREATE TABLE courses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  department_id  uuid NOT NULL,
  code           text NOT NULL CHECK (length(code) BETWEEN 1 AND 32),
  title          text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  credits        numeric(4, 1) NOT NULL CHECK (credits > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id)
);
CREATE INDEX courses_department_idx ON courses (department_id);

CREATE TABLE course_offerings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  course_id          uuid NOT NULL,
  term_id            uuid NOT NULL,
  section            text NOT NULL DEFAULT 'A' CHECK (length(section) BETWEEN 1 AND 16),
  capacity           integer CHECK (capacity > 0),
  grades_status      text NOT NULL DEFAULT 'draft'
                       CHECK (grades_status IN ('draft', 'submitted', 'returned', 'approved', 'published')),
  return_reason      text CHECK (length(return_reason) <= 2000),
  grades_submitted_by  uuid,
  grades_submitted_at  timestamptz,
  grades_approved_by   uuid,
  grades_approved_at   timestamptz,
  grades_published_by  uuid,
  grades_published_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, course_id, term_id, section),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, course_id) REFERENCES courses (tenant_id, id),
  FOREIGN KEY (tenant_id, term_id) REFERENCES academic_terms (tenant_id, id),
  FOREIGN KEY (tenant_id, grades_submitted_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, grades_approved_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, grades_published_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX course_offerings_status_idx ON course_offerings (tenant_id, grades_status);

CREATE TABLE enrollments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  offering_id      uuid NOT NULL,
  student_user_id  uuid NOT NULL,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (offering_id, student_user_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, offering_id) REFERENCES course_offerings (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, student_user_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX enrollments_student_idx ON enrollments (student_user_id);

CREATE TABLE grades (
  enrollment_id  uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  score          numeric(4, 2) NOT NULL CHECK (score >= 0 AND score <= 20),
  entered_by     uuid NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, enrollment_id) REFERENCES enrollments (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, entered_by) REFERENCES users (tenant_id, id)
);

-- Dernier rempart : même une requête qui oublierait de vérifier le statut ne
-- peut pas modifier une note une fois la feuille soumise.
CREATE OR REPLACE FUNCTION app.forbid_locked_grade_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  status text;
BEGIN
  SELECT o.grades_status INTO status
    FROM enrollments e JOIN course_offerings o ON o.id = e.offering_id
   WHERE e.id = COALESCE(NEW.enrollment_id, OLD.enrollment_id);
  IF status NOT IN ('draft', 'returned') THEN
    RAISE EXCEPTION 'feuille de notes verrouillée (%)', status USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER grades_locked
  BEFORE INSERT OR UPDATE OR DELETE ON grades
  FOR EACH ROW EXECUTE FUNCTION app.forbid_locked_grade_change();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['academic_terms', 'courses', 'course_offerings', 'enrollments', 'grades'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())',
      t
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON academic_terms, courses, course_offerings TO elongo_app, elongo_platform;
GRANT SELECT, INSERT, DELETE ON enrollments TO elongo_app, elongo_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON grades TO elongo_app, elongo_platform;
