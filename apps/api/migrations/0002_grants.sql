-- Droits des rôles de connexion. Les rôles eux-mêmes sont créés par
-- src/db/migrate.ts (leurs mots de passe viennent de l'environnement).
--   elongo_app      : API des universités, toujours soumise à la RLS.
--   elongo_platform : portail Super Admin, crée les tenants ; soumis à la RLS
--                     lui aussi pour les tables tenant.

GRANT USAGE ON SCHEMA app TO elongo_app, elongo_platform;
GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO elongo_app, elongo_platform;

GRANT SELECT ON tenants, tenant_domains TO elongo_app;
GRANT SELECT, INSERT, UPDATE ON tenants, tenant_domains TO elongo_platform;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenant_branding, feature_flags, users, roles, role_permissions,
  faculties, departments, role_assignments
  TO elongo_app, elongo_platform;

-- Le journal d'audit ne s'écrit qu'en INSERT.
GRANT SELECT, INSERT ON audit_log TO elongo_app, elongo_platform;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO elongo_app, elongo_platform;
