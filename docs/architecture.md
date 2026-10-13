# Architecture : décisions appliquées dans le code

Résumé des décisions du document d'architecture, avec leur traduction dans ce dépôt.

## ADR-001 : isolation des données

Base PostgreSQL partagée, `tenant_id` sur chaque table, Row-Level Security
activée et forcée (`FORCE ROW LEVEL SECURITY`). La fonction
`app.current_tenant_id()` lit `app.tenant_id`, fixé par transaction avec
`set_config(..., true)` : il disparaît au COMMIT et ne peut pas fuir vers la
requête suivante servie par la même connexion du pool.

Les clés étrangères entre tables tenant sont composites (`tenant_id, id`) :
une ligne ne peut pas référencer une ligne d'une autre université.

Trois rôles PostgreSQL :

| Rôle | Usage | RLS |
| --- | --- | --- |
| propriétaire (`postgres` en dev) | migrations uniquement | contourne |
| `elongo_app` | API des universités | soumis |
| `elongo_platform` | portail Super Admin, création des universités | soumis ; lit des agrégats via `app.platform_tenant_stats()` |

## ADR-002 : monolithe modulaire

Une application NestJS ; un dossier par domaine sous `apps/api/src`. Un module
ne lit pas les tables d'un autre module directement.

## ADR-003 : Keycloak

Un realm par université, nommé `univ-<slug>`, et un realm `elongo-platform`
pour les administrateurs de la plateforme. L'API vérifie que le jeton vient du
realm de l'université servie par le nom d'hôte. À la première connexion, un
utilisateur invité est relié à son compte Keycloak par e-mail vérifié.

Le realm est créé à l'onboarding via l'API d'administration de Keycloak
(`src/keycloak`), avant l'écriture en base. Le Recteur y est invité avec
vérification d'e-mail, mot de passe et TOTP obligatoires.

## RBAC

Permissions fines (`src/rbac/permissions.ts`), regroupées en rôles par
université. Les rôles système (Recteur, SG académique, SG administratif,
SG recherche, Professeur, Étudiant) sont créés à l'onboarding. Chaque
attribution porte une portée ; une portée faculté couvre ses départements.

## Audit

`audit_log` : `INSERT` seul pour les rôles applicatifs, trigger qui refuse
`UPDATE` et `DELETE` même au propriétaire, et chaîne de hash SHA-256 par
université vérifiable via `GET /v1/audit-logs/verify`.

## Portail web

`apps/web` (Next.js, rendu serveur) sert toutes les universités. Le domaine de
la requête est transmis à l'API dans l'en-tête `x-elongo-host`, qui désigne
l'université ; les couleurs de la marque deviennent des variables CSS.

Connexion : flux OIDC « authorization code » avec PKCE vers le realm de
l'université, échange du code côté serveur. Les jetons sont gardés dans deux
cookies chiffrés (AES-256-GCM), `httpOnly`, liés au domaine ; le navigateur ne
voit jamais de jeton. Le jeton d'accès (15 min) est renouvelé par
`/auth/refresh` grâce au jeton de rafraîchissement.

Les menus de l'espace connecté sont calculés à partir des permissions
(`src/lib/navigation.ts`), comme le fera l'app mobile.
