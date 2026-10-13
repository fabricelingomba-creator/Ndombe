-- Relevés de notes officiels. L'étudiant demande, le secrétariat académique
-- valide : les notes publiées sont alors figées dans `snapshot`, avec leur
-- empreinte SHA-256 et un code de vérification public. Un relevé validé ne
-- change plus, même si une note est corrigée plus tard (il faut en émettre un
-- nouveau).

CREATE TABLE transcripts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_user_id    uuid NOT NULL,
  status             text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'validated', 'rejected')),
  requested_at       timestamptz NOT NULL DEFAULT now(),
  decided_by         uuid,
  decided_at         timestamptz,
  reject_reason      text CHECK (length(reject_reason) <= 2000),
  snapshot           jsonb,
  content_hash       text,
  verification_code  text UNIQUE,
  CHECK ((status = 'validated') = (snapshot IS NOT NULL AND content_hash IS NOT NULL AND verification_code IS NOT NULL)),
  FOREIGN KEY (tenant_id, student_user_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX transcripts_student_idx ON transcripts (student_user_id, requested_at DESC);
CREATE INDEX transcripts_status_idx ON transcripts (tenant_id, status, requested_at);
-- Une seule demande en attente par étudiant.
CREATE UNIQUE INDEX transcripts_one_pending_idx ON transcripts (student_user_id) WHERE status = 'requested';

-- Un relevé validé est figé : ni modification ni suppression.
CREATE OR REPLACE FUNCTION app.forbid_validated_transcript_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'requested' THEN
    RAISE EXCEPTION 'relevé déjà traité (%)', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER transcripts_frozen
  BEFORE UPDATE OR DELETE ON transcripts
  FOR EACH ROW EXECUTE FUNCTION app.forbid_validated_transcript_change();

ALTER TABLE transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcripts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON transcripts
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON transcripts TO elongo_app, elongo_platform;

-- Vérification publique d'un relevé par son code, sans connaître l'université
-- ni ouvrir la RLS : la fonction ne renvoie que le strict nécessaire.
CREATE OR REPLACE FUNCTION app.verify_transcript(code text)
  RETURNS TABLE (tenant_id uuid, student_name text, issued_at timestamptz, content_hash text,
                 credits_earned numeric, cumulative_average numeric)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT t.tenant_id, t.snapshot->'student'->>'fullName', t.decided_at, t.content_hash,
           (t.snapshot->'summary'->>'creditsEarned')::numeric,
           (t.snapshot->'summary'->>'average')::numeric
      FROM transcripts t
     WHERE t.verification_code = code AND t.status = 'validated'
  $$;
REVOKE ALL ON FUNCTION app.verify_transcript(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.verify_transcript(text) TO elongo_app;
