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
attribution porte une portée ; une portée faculté couvre ses départements,
une portée département ses cours. La portée « course » désigne une offre de
cours (un cours donné pendant une période) : c'est ainsi qu'un professeur
reçoit ses enseignements. Les lectures communes au campus (annonces, liste
des facultés, calendrier) acceptent la permission détenue sur n'importe
quelle portée (`@RequirePermission(..., 'any')`).

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

## Cours et notes

Catalogue par département (`courses`), périodes (`academic_terms`), offres
(`course_offerings` : un cours, une période, une section), inscriptions et
notes sur 20. La feuille de notes d'une offre suit un circuit :

```
brouillon → soumise → approuvée → publiée
               └→ renvoyée (avec motif) → soumise …
```

- Le professeur saisit et soumet (feuille complète obligatoire).
- Le SG académique de la faculté approuve ou renvoie ; on n'approuve pas une
  feuille qu'on a soumise soi-même (principe des quatre yeux).
- La publication rend les notes visibles aux étudiants, avec la moyenne
  pondérée par les crédits et les crédits acquis (note ≥ 10/20).
- Une fois soumise, une note n'est plus modifiable : l'API le refuse et un
  trigger PostgreSQL le refuse aussi. Chaque étape est tracée dans l'audit.

## Relevés officiels

L'étudiant demande un relevé ; le secrétariat académique (permission
`transcripts:validate` sur toute l'université) le valide ou le refuse avec un
motif. À la validation, les notes publiées sont figées dans `transcripts.snapshot`
avec leur empreinte SHA-256 (JSON canonique) et un code de vérification de
12 caractères (base 32 de Crockford, 60 bits). Un trigger interdit ensuite toute
modification ; une note corrigée plus tard demande un nouveau relevé.

Le PDF (pdfkit, aux couleurs de l'université) est rendu à la demande à partir du
contenu figé : il porte le code, l'empreinte et l'adresse de la page publique
`/verifier`. Cette page appelle `GET /v1/public/transcripts/verify/:code`, qui
passe par la fonction `app.verify_transcript` (SECURITY DEFINER, quelques champs
seulement) et ne répond que pour l'université du domaine appelé.

## Paiements

Les montants sont stockés en unités mineures (`bigint`, centimes) avec leur
devise (`CDF`, `USD`) ; aucun total n'additionne deux devises. Un frais
(`fee_structures`) est facturé à chaque étudiant (`invoices`, une facture par
frais et par étudiant) ; chaque tentative est un `payments` chez un prestataire.

**Prestataires.** Tous implémentent `PaymentProvider` (`prepareSecrets`,
`createCharge`, `parseWebhook`) ; facturation, idempotence, webhooks et audit
ne dépendent pas du prestataire. Livré : `sandbox` (Mobile Money simulé,
interdit en production). Un agrégateur Mobile Money réel (M-Pesa, Orange Money,
Airtel Money) s'ajoute comme un nouvel adaptateur. Pas de paiement par carte
pour l'instant (décision du projet).

**Secrets.** Les clés de chaque université sont chiffrées en AES-256-GCM avec
`PAYMENT_SECRETS_KEY` (hors base), l'université et le prestataire servant de
données authentifiées : un chiffré copié vers une autre université ne se
déchiffre pas. Ni l'API ni l'audit ne renvoient un secret enregistré.

**Idempotence et double paiement.** `POST /v1/me/invoices/:id/payments` exige
l'en-tête `Idempotency-Key` (unique par université) : rejouée, la requête renvoie
le même paiement sans rappeler le prestataire. Le portail génère la clé au rendu
du formulaire, un double clic est donc sans effet. Un paiement en attente de
moins de 30 minutes bloque toute nouvelle tentative sur la facture. L'appel au
prestataire se fait hors transaction ; en cas d'échec le paiement passe à
`failed` et l'API répond 502.

**Webhooks.** `POST /webhooks/payments/:provider/:tenant`, public mais signé
(HMAC-SHA256 de `t.corps` horodaté, fenêtre de 5 minutes) sur le corps
brut. Le portail relaie la même route sur son domaine, sans les cookies. Chaque
événement est enregistré une fois (`payment_events`, unique par université,
prestataire et identifiant) avec son issue : `applied`, `duplicate`, `ignored`,
`unknown_payment`, `already_final` ou `amount_mismatch` (montant ou devise
différents du paiement : rien n'est réglé). Un webhook arrivé avant
l'enregistrement de la référence est rattaché par l'identifiant Elongo que
l'agrégateur renvoie. Un paiement abouti ou échoué est figé par trigger ; la
facture passe à `paid` quand les paiements aboutis couvrent son montant.

### Paiement par banque

L'étudiant dépose les frais sur un compte de l'université (`bank_accounts`, un
par banque et par devise) puis téléverse son bordereau depuis l'espace étudiant
(`POST /v1/me/invoices/:id/bank-payments`, multipart, `Idempotency-Key`). Le
paiement (`provider = 'bank'`) reste en attente jusqu'à la décision d'une personne
détenant `payments:validate` (Recteur, SG administratif) : validé, il règle la
facture ; refusé, son motif est montré à l'étudiant, qui peut renvoyer un
bordereau. La décision est définitive (trigger) et personne ne traite son propre
bordereau.

Contrôles : fichier PDF, JPEG ou PNG reconnu par son contenu (5 Mo au plus),
date de dépôt plausible, devise du compte égale à celle de la facture, montant
au plus égal au reste à payer. Un même numéro de bordereau sur un même compte,
ou un même fichier (SHA-256), ne sert qu'une fois, sauf s'il a été refusé. Un
bordereau en attente bloque tout autre paiement de la facture.

Le fichier est stocké en base (`bytea`, sous RLS) en attendant un stockage objet.
Il n'est servi qu'aux valideurs : une image s'affiche dans un bac à sable
(`Content-Security-Policy: sandbox`), un PDF est téléchargé.
