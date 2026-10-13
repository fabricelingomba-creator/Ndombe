-- Elongo, phase 0 : fondations multi-tenant.
-- Chaque table métier porte tenant_id et est protégée par Row-Level Security.
-- L'API se connecte avec le rôle elongo_app (sans BYPASSRLS) et fixe
-- app.tenant_id au début de chaque transaction via set_config(..., true).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS app;

-- Tenant courant de la transaction, NULL si non défini (aucune ligne visible).
CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- ---------------------------------------------------------------------------
-- Tables plateforme (sans RLS) : nécessaires pour résoudre le tenant d'une requête.
-- ---------------------------------------------------------------------------

CREATE TABLE tenants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  plan            text NOT NULL DEFAULT 'standard' CHECK (plan IN ('standard', 'premium')),
  keycloak_realm  text NOT NULL UNIQUE,
  default_locale  text NOT NULL DEFAULT 'fr',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_domains (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  domain      text NOT NULL UNIQUE CHECK (domain = lower(domain)),
  is_primary  boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_domains_tenant_idx ON tenant_domains (tenant_id);

-- ---------------------------------------------------------------------------
-- Tables tenant (avec RLS).
-- ---------------------------------------------------------------------------

CREATE TABLE tenant_branding (
  tenant_id        uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  logo_url         text,
  favicon_url      text,
  primary_color    text NOT NULL DEFAULT '#1D4ED8' CHECK (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  secondary_color  text NOT NULL DEFAULT '#F59E0B' CHECK (secondary_color ~ '^#[0-9A-Fa-f]{6}$'),
  hero             jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feature_flags (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key        text NOT NULL,
  enabled    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_id  text,
  email        text NOT NULL CHECK (email = lower(email)),
  full_name    text NOT NULL,
  status       text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  UNIQUE (tenant_id, email),
  UNIQUE (tenant_id, external_id),
  UNIQUE (tenant_id, id)
);

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         text NOT NULL,
  name        text NOT NULL,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key),
  UNIQUE (tenant_id, id)
);

CREATE TABLE role_permissions (
  tenant_id   uuid NOT NULL,
  role_id     uuid NOT NULL,
  permission  text NOT NULL,
  PRIMARY KEY (role_id, permission),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE faculties (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        text NOT NULL,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

CREATE TABLE departments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  faculty_id  uuid NOT NULL,
  code        text NOT NULL,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, faculty_id) REFERENCES faculties (tenant_id, id) ON DELETE CASCADE
);

-- Une attribution de rôle porte une portée : toute l'université, une faculté,
-- un département ou un cours. scope_id est NULL pour la portée université.
CREATE TABLE role_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  role_id     uuid NOT NULL,
  scope_type  text NOT NULL CHECK (scope_type IN ('university', 'faculty', 'department', 'course')),
  scope_id    uuid,
  granted_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope_type = 'university') = (scope_id IS NULL)),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX role_assignments_unique_idx
  ON role_assignments (user_id, role_id, scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Journal d'audit en ajout seul, chaîné par hash pour détecter toute altération.
CREATE TABLE audit_log (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  actor_user_id  uuid,
  action         text NOT NULL,
  entity_type    text NOT NULL,
  entity_id      text,
  before         jsonb,
  after          jsonb,
  ip             inet,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  prev_hash      text,
  hash           text NOT NULL
);
CREATE INDEX audit_log_tenant_idx ON audit_log (tenant_id, id DESC);

CREATE OR REPLACE FUNCTION app.forbid_audit_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log est en ajout seul';
END $$;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION app.forbid_audit_mutation();

-- ---------------------------------------------------------------------------
-- Politiques RLS : une ligne n'est visible et modifiable que pour son tenant.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_branding', 'feature_flags', 'users', 'roles', 'role_permissions',
    'faculties', 'departments', 'role_assignments', 'audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())',
      t
    );
  END LOOP;
END $$;
