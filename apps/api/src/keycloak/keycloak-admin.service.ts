import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, Env } from '../config/env';

export const KEYCLOAK_FETCH = Symbol('KEYCLOAK_FETCH');
export type FetchLike = typeof fetch;

export interface RealmSpec {
  realm: string;
  displayName: string;
  /** Domaines du portail web, pour les URL de redirection autorisées. */
  domains: string[];
  locale: string;
}

export interface InvitedUser {
  email: string;
  fullName: string;
  /** Les comptes d'administration doivent configurer un second facteur (TOTP). */
  requireMfa: boolean;
}

export interface InviteResult {
  userId: string;
  /** false si Keycloak n'a pas pu envoyer l'e-mail (SMTP non configuré, par exemple). */
  emailSent: boolean;
}

export class KeycloakAdminError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const MOBILE_REDIRECT_URI = 'elongo://auth/callback';

/**
 * Client minimal de l'API d'administration Keycloak. Chaque opération est
 * idempotente (un realm ou un utilisateur déjà présent n'est pas une erreur),
 * pour qu'un onboarding interrompu puisse être relancé sans risque.
 */
@Injectable()
export class KeycloakAdminService {
  private readonly logger = new Logger(KeycloakAdminService.name);
  private readonly baseUrl: string;
  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(KEYCLOAK_FETCH) private readonly http: FetchLike,
  ) {
    this.baseUrl = env.KEYCLOAK_URL.replace(/\/$/, '');
  }

  get enabled(): boolean {
    return Boolean(this.env.KEYCLOAK_ADMIN_CLIENT_ID && this.env.KEYCLOAK_ADMIN_CLIENT_SECRET);
  }

  async ensureRealm(spec: RealmSpec): Promise<'created' | 'exists'> {
    const res = await this.call('POST', '/admin/realms', buildRealm(spec));
    if (res.status === 409) return 'exists';
    await this.expectOk(res, `création du realm ${spec.realm}`);
    return 'created';
  }

  async inviteUser(realm: string, user: InvitedUser): Promise<InviteResult> {
    const [firstName, ...rest] = user.fullName.trim().split(/\s+/);
    const requiredActions = ['VERIFY_EMAIL', 'UPDATE_PASSWORD', ...(user.requireMfa ? ['CONFIGURE_TOTP'] : [])];
    const created = await this.call('POST', `/admin/realms/${encodeURIComponent(realm)}/users`, {
      username: user.email,
      email: user.email,
      firstName,
      lastName: rest.join(' ') || undefined,
      enabled: true,
      emailVerified: false,
      requiredActions,
    });
    if (created.status !== 409) await this.expectOk(created, `création de ${user.email}`);

    const userId = await this.findUserId(realm, user.email);
    const mail = await this.call(
      'PUT',
      `/admin/realms/${encodeURIComponent(realm)}/users/${userId}/execute-actions-email?lifespan=${7 * 24 * 3600}`,
      requiredActions,
    );
    if (!mail.ok) {
      this.logger.warn(`E-mail d'invitation non envoyé à ${user.email} (${mail.status})`);
    }
    return { userId, emailSent: mail.ok };
  }

  private async findUserId(realm: string, email: string): Promise<string> {
    const res = await this.call(
      'GET',
      `/admin/realms/${encodeURIComponent(realm)}/users?email=${encodeURIComponent(email)}&exact=true`,
    );
    await this.expectOk(res, `recherche de ${email}`);
    const users = (await res.json()) as { id: string }[];
    if (!users[0]) throw new KeycloakAdminError(`Utilisateur ${email} introuvable après création`);
    return users[0].id;
  }

  private async token(): Promise<string> {
    if (!this.enabled) throw new KeycloakAdminError('Client d’administration Keycloak non configuré');
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now()) return this.cachedToken.value;
    const res = await this.http(`${this.baseUrl}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.env.KEYCLOAK_ADMIN_CLIENT_ID!,
        client_secret: this.env.KEYCLOAK_ADMIN_CLIENT_SECRET!,
      }),
    });
    await this.expectOk(res, 'obtention du jeton administrateur');
    const body = (await res.json()) as { access_token: string; expires_in: number };
    // Marge de 30 s pour ne jamais envoyer un jeton qui expire en route.
    this.cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 30) * 1000 };
    return body.access_token;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.token();
    return this.http(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private async expectOk(res: Response, what: string) {
    if (res.ok) return;
    const detail = await res.text().catch(() => '');
    throw new KeycloakAdminError(`Keycloak : échec de ${what} (${res.status}) ${detail}`.trim(), res.status);
  }
}

/** Realm d'une université : connexion par e-mail, protection contre le bourrage d'identifiants, PKCE. */
export function buildRealm(spec: RealmSpec) {
  const webOrigins = spec.domains.map((d) => `https://${d}`);
  return {
    realm: spec.realm,
    displayName: spec.displayName,
    enabled: true,
    sslRequired: 'external',
    registrationAllowed: false,
    loginWithEmailAllowed: true,
    duplicateEmailsAllowed: false,
    resetPasswordAllowed: true,
    verifyEmail: true,
    bruteForceProtected: true,
    permanentLockout: false,
    failureFactor: 10,
    accessTokenLifespan: 900,
    ssoSessionIdleTimeout: 1800,
    revokeRefreshToken: true,
    refreshTokenMaxReuse: 0,
    internationalizationEnabled: true,
    supportedLocales: ['fr', 'en'],
    defaultLocale: spec.locale,
    otpPolicyType: 'totp',
    clients: [
      {
        clientId: 'elongo-portal',
        name: 'Portail web',
        publicClient: true,
        standardFlowEnabled: true,
        directAccessGrantsEnabled: false,
        redirectUris: webOrigins.map((o) => `${o}/*`),
        webOrigins,
        attributes: { 'pkce.code.challenge.method': 'S256', 'post.logout.redirect.uris': '+' },
      },
      {
        clientId: 'elongo-mobile',
        name: 'Application mobile',
        publicClient: true,
        standardFlowEnabled: true,
        directAccessGrantsEnabled: false,
        redirectUris: [MOBILE_REDIRECT_URI],
        attributes: { 'pkce.code.challenge.method': 'S256' },
      },
    ],
  };
}
