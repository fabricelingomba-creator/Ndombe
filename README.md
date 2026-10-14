# Elongo

Plateforme SaaS multi-tenant en marque blanche pour la gestion des universités :
portail public à la marque de chaque établissement, portails étudiants,
enseignants et administration, application mobile unique, portail Super Admin.

Le document d'architecture (stack, isolation des données, RBAC, paiements,
notifications, mobile, feuille de route) est tenu dans le projet Claude ;
ce dépôt en reprend les décisions dans [docs/architecture.md](docs/architecture.md).

## État : phases 0 et 1 terminées, phase 2 en cours

| Brique | Où |
| --- | --- |
| Monorepo pnpm, API NestJS (TypeScript) | `apps/api` |
| Schéma multi-tenant, Row-Level Security PostgreSQL | `apps/api/migrations` |
| Résolution de l'université par domaine ou sous-domaine | `apps/api/src/tenancy` |
| Authentification Keycloak (un realm par université) | `apps/api/src/auth` |
| Création des realms et invitation du Recteur | `apps/api/src/keycloak` |
| RBAC par permissions et portées (université, faculté, département, cours) | `apps/api/src/rbac` |
| Journal d'audit en ajout seul, chaîné par hash | `apps/api/src/audit` |
| Onboarding d'une université (Super Admin) | `apps/api/src/platform` |
| Tests d'isolation entre universités | `apps/api/test` |
| Portail web à la marque (Next.js) : accueil, connexion, espace | `apps/web` |
| Cours, inscriptions, notes et circuit de validation | `apps/api/src/academic`, `apps/web/src/app/espace` |
| Relevés officiels en PDF, vérifiables par code | `apps/api/src/transcripts`, `apps/web/src/app/verifier` |
| Frais, factures, paiements Mobile Money et par banque (bordereau validé par la finance) | `apps/api/src/payments`, `apps/web/src/app/espace/paiements` |
| Notifications dans l'espace et par e-mail | `apps/api/src/notifications` |
| Application mobile (Expo) : SSO, biométrie, hors ligne, paiement et bordereau | `apps/mobile` |
| Types et règles partagés entre le web et le mobile | `packages/shared` |

## Démarrer en local

Prérequis : Node 22, pnpm 10, Docker.

```bash
pnpm install
docker compose up -d                  # PostgreSQL 16 + Keycloak
cp apps/api/.env.example apps/api/.env
# Facultatif, pour les paiements : renseigner PAYMENT_SECRETS_KEY dans apps/api/.env
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
pnpm db:migrate                       # rôles de connexion + migrations
pnpm db:seed                          # université « demo »
pnpm dev                              # API sur http://localhost:3000
```

Vérifier :

```bash
curl http://demo.elongo.localhost:3000/v1/tenant/manifest
```

Portail web, dans un second terminal :

```bash
cp apps/web/.env.example apps/web/.env.local
pnpm --filter @elongo/web dev        # http://demo.elongo.localhost:3001
```

Le portail lit le domaine de la requête et demande à l'API quelle université
servir ; aucune configuration par université n'est nécessaire côté web.

Comptes Keycloak de développement (http://localhost:8080) :

| Realm | Utilisateur | Mot de passe | Rôle |
| --- | --- | --- | --- |
| `elongo-platform` | `ops` | `ops` | Super Admin |
| `univ-demo` | `recteur` | `recteur` | Recteur de l'université demo |
| `univ-demo` | `sgacad` | `sgacad` | SG académique de la Faculté des sciences |
| `univ-demo` | `professeur` | `professeur` | Professeure de INF101 et INF102 |
| `univ-demo` | `etudiant`, `etudiante` | idem | Étudiants inscrits aux deux cours |

Le seed crée la Faculté des sciences, le département Informatique, la période
2026-S1 et les cours INF101 et INF102 ; chaque compte se relie à son profil à
la première connexion (e-mail vérifié).

Si `PAYMENT_SECRETS_KEY` est renseignée, le seed facture aussi deux frais aux
étudiants (minerval en dollars, bibliothèque en francs congolais) et active le
Mobile Money simulé : sur `/espace/paiements`, l'étudiant paie avec un numéro
fictif puis simule la validation sur son téléphone. Il peut aussi payer à la
banque (deux comptes de démonstration) et téléverser son bordereau, que le
Recteur valide ou refuse sur `/espace/finances`. Aucun argent ne circule ;
ce prestataire est refusé au démarrage en production.

Chaque compte a une boîte de notifications (la cloche en haut de l'espace) :
facture émise, paiement reçu ou refusé, bordereau à valider ou traité, notes à
approuver, renvoyées ou publiées, relevé demandé ou prêt, rappels avant et
après l'échéance, annonces. En développement, les e-mails correspondants sont
écrits dans le journal de l'API au lieu d'être envoyés (`EMAIL_TRANSPORT=log`).

Obtenir un jeton et appeler l'API :

```bash
TOKEN=$(curl -s -d client_id=elongo-portal -d grant_type=password \
  -d username=recteur -d password=recteur \
  http://localhost:8080/realms/univ-demo/protocol/openid-connect/token | jq -r .access_token)
curl -H "Authorization: Bearer $TOKEN" http://demo.elongo.localhost:3000/v1/me
```

## Application mobile

Une seule app (iOS et Android) pour toutes les universités : au premier
lancement, l'utilisateur saisit le code de son université (`unikin`) ou
l'adresse de son portail ; l'app se met à ses couleurs puis ouvre la page de
connexion de son realm Keycloak (client `elongo-mobile`, PKCE, retour sur
`elongo://auth/callback`). Le mot de passe n'est jamais saisi dans l'app.

```bash
cd apps/mobile
EXPO_PUBLIC_API_URL=http://<ip-du-poste>:3000 pnpm start   # puis a (Android) ou i (iOS)
pnpm web                                                  # aperçu dans le navigateur
pnpm test && pnpm typecheck
```

La connexion SSO (schéma `elongo://`) et la biométrie demandent un
*development build* (`npx expo run:android`, `npx expo run:ios` ou EAS Build),
pas Expo Go. Pour publier : `eas build` puis `eas submit`, avec
`EXPO_PUBLIC_API_URL` fixé sur l'adresse de production de l'API.

- **Étudiant** : accueil (reste à payer, résultats, annonces), notifications,
  factures, paiement Mobile Money, dépôt bancaire avec photo du bordereau
  (appareil photo, galerie ou PDF), notes, relevés officiels en PDF, profil.
- **Personnel** : notifications et accès direct aux écrans du portail web
  (validation des notes, relevés, finances).
- **Sécurité** : jeton de renouvellement dans le trousseau du téléphone
  (Keychain, Keystore), jeton d'accès en mémoire seulement, verrou par
  empreinte ou visage après 5 minutes en arrière-plan, données locales effacées
  à la déconnexion.
- **Hors ligne** : chaque écran garde sa dernière copie et affiche sa date ;
  marquer une notification lue attend le retour du réseau. Un paiement exige
  toujours le réseau.

## Création automatique des realms

À l'onboarding d'une université (`POST /platform/tenants`), l'API crée le realm
Keycloak `univ-<slug>` (clients web et mobile en PKCE, protection contre le
bourrage d'identifiants, inscription libre fermée) puis invite le Recteur :
il reçoit un e-mail pour vérifier son adresse, choisir son mot de passe et
configurer la double authentification.

Il faut pour cela un client de service dans le realm `master` :

1. Console Keycloak, realm `master`, Clients, créer `elongo-provisioner`.
2. Activer « Client authentication » et « Service accounts roles ».
3. Onglet « Service accounts roles » : attribuer le rôle `admin` du realm.
4. Copier le secret dans `KEYCLOAK_ADMIN_CLIENT_SECRET` (et l'identifiant dans `KEYCLOAK_ADMIN_CLIENT_ID`).

Sans ces variables, l'onboarding n'écrit que la base. Si Keycloak refuse le
realm, rien n'est écrit en base ; si seule l'invitation échoue, l'université
est créée et `POST /platform/tenants/<slug>/keycloak/sync` rejoue l'étape.
L'envoi d'e-mails suppose un serveur SMTP configuré dans le realm.

## Tests

```bash
pnpm test
```

Les tests créent une base PostgreSQL neuve par suite (variable
`TEST_DATABASE_SERVER_URL`, par défaut `postgres://postgres:postgres@localhost:5432`)
et vérifient notamment qu'une université ne peut ni lire ni écrire les données
d'une autre, par l'API comme directement en base.

## Règles du projet

- Toute table métier porte `tenant_id` et une politique RLS ; l'API se connecte
  avec le rôle `elongo_app`, qui ne contourne jamais la RLS.
- Toute requête de données passe par `DatabaseService.withTenant()`.
- Le code vérifie des permissions (`@RequirePermission('grades:publish')`),
  jamais des noms de rôles.
- Toute modification sensible (notes, finances, rôles, configuration) écrit
  dans le journal d'audit, dans la même transaction.
- Aucun secret dans le dépôt : il est public.
