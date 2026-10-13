-- Annonces : publiques (page d'accueil) ou réservées au campus (utilisateurs connectés).

CREATE TABLE announcements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body          text NOT NULL CHECK (length(body) <= 10000),
  visibility    text NOT NULL CHECK (visibility IN ('public', 'campus')),
  published_at  timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX announcements_feed_idx ON announcements (tenant_id, published_at DESC) WHERE deleted_at IS NULL;

ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON announcements
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON announcements TO elongo_app, elongo_platform;
