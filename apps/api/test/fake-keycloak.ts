import type { FetchLike } from '../src/keycloak/keycloak-admin.service';

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

/**
 * Faux serveur d'administration Keycloak, en mémoire : realms et utilisateurs.
 * `failOn` force une réponse d'erreur sur un appel donné ("POST /admin/realms").
 */
export function fakeKeycloak(options: { failOn?: Record<string, number>; smtp?: boolean } = {}) {
  const calls: RecordedCall[] = [];
  const realms = new Set<string>();
  const users = new Map<string, { id: string; email: string; requiredActions: string[] }>();
  let tokensIssued = 0;

  const json = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const raw = typeof init?.body === 'string' ? init.body : init?.body?.toString();
    const body = raw && init?.headers && JSON.stringify(init.headers).includes('application/json') ? JSON.parse(raw) : raw;
    const key = `${method} ${url.pathname}`;
    calls.push({ method, path: url.pathname + url.search, body });

    const forced = options.failOn?.[key];
    if (forced) return json(forced, { error: 'forced' });

    if (key === 'POST /realms/master/protocol/openid-connect/token') {
      tokensIssued++;
      return json(200, { access_token: `admin-token-${tokensIssued}`, expires_in: 300 });
    }
    if (key === 'POST /admin/realms') {
      const realm = (body as { realm: string }).realm;
      if (realms.has(realm)) return json(409, { errorMessage: 'Conflict' });
      realms.add(realm);
      return json(201);
    }
    let m = /^\/admin\/realms\/([^/]+)\/users$/.exec(url.pathname);
    if (m && method === 'POST') {
      const u = body as { email: string; requiredActions: string[] };
      const k = `${m[1]}:${u.email}`;
      if (users.has(k)) return json(409, { errorMessage: 'User exists' });
      users.set(k, { id: `kc-${users.size + 1}`, email: u.email, requiredActions: u.requiredActions });
      return json(201);
    }
    if (m && method === 'GET') {
      const u = users.get(`${m[1]}:${url.searchParams.get('email')}`);
      return json(200, u ? [{ id: u.id, email: u.email }] : []);
    }
    m = /^\/admin\/realms\/([^/]+)\/users\/([^/]+)\/execute-actions-email$/.exec(url.pathname);
    if (m && method === 'PUT') return options.smtp === false ? json(500, { error: 'SMTP' }) : json(204);
    return json(404, { error: `route inconnue ${key}` });
  };

  return {
    fetch,
    calls,
    realms,
    users,
    get tokensIssued() {
      return tokensIssued;
    },
  };
}

export const KEYCLOAK_ADMIN_ENV = {
  KEYCLOAK_ADMIN_CLIENT_ID: 'elongo-provisioner',
  KEYCLOAK_ADMIN_CLIENT_SECRET: 'secret-de-test',
};
