-- Le portail Super Admin ne lit pas les données nominatives des universités :
-- il passe par cette fonction qui ne renvoie que des compteurs agrégés.
-- SECURITY DEFINER : elle s'exécute avec les droits de son propriétaire,
-- et seul elongo_platform peut l'appeler.

CREATE OR REPLACE FUNCTION app.platform_tenant_stats()
RETURNS TABLE (tenant_id uuid, users_total bigint, users_active bigint, faculties_total bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.id,
         (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.deleted_at IS NULL),
         (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.status = 'active' AND u.deleted_at IS NULL),
         (SELECT count(*) FROM faculties f WHERE f.tenant_id = t.id AND f.deleted_at IS NULL)
    FROM tenants t
$$;

REVOKE ALL ON FUNCTION app.platform_tenant_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.platform_tenant_stats() TO elongo_platform;
