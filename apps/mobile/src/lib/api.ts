/**
 * Client de l'API Elongo pour l'app. L'université est désignée par l'en-tête
 * x-elongo-tenant (son code) ; le jeton d'accès vient du realm de cette
 * université et l'API revérifie chaque permission.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  tenant: { slug: string } | { host: string };
  /** Jeton d'accès courant (en mémoire), ou null si déconnecté. */
  accessToken: () => string | null;
  /** Renouvelle le jeton (refresh token) ; null si la session est finie. */
  refresh: () => Promise<string | null>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

type Body = { json: unknown } | { form: FormData } | undefined;

export class ApiClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: ApiClientOptions) {
    this.fetchFn = options.fetch ?? ((...args) => fetch(...args));
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, json?: unknown, headers: Record<string, string> = {}): Promise<T> {
    return this.request<T>('POST', path, json === undefined ? undefined : { json }, headers);
  }

  put<T>(path: string, json: unknown): Promise<T> {
    return this.request<T>('PUT', path, { json });
  }

  postForm<T>(path: string, form: FormData, headers: Record<string, string> = {}): Promise<T> {
    return this.request<T>('POST', path, { form }, headers);
  }

  /** Requête publique (manifeste de l'université), sans jeton. */
  publicGet<T>(path: string): Promise<T> {
    return this.request<T>('GET', path, undefined, {}, false);
  }

  url(path: string): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}${path}`;
  }

  /** En-têtes d'une requête authentifiée faite hors de ce client (téléchargement de fichier). */
  async authHeaders(fresh = false): Promise<Record<string, string>> {
    const token = fresh ? await this.options.refresh() : this.options.accessToken();
    if (!token) throw new ApiError(401, 'Session expirée : reconnectez-vous.');
    return { ...this.tenantHeaders(), authorization: `Bearer ${token}` };
  }

  private tenantHeaders(): Record<string, string> {
    const t = this.options.tenant;
    return 'slug' in t ? { 'x-elongo-tenant': t.slug } : { 'x-elongo-host': t.host };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Body,
    headers: Record<string, string> = {},
    authenticated = true,
  ): Promise<T> {
    const call = async (token: string | null) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 20_000);
      try {
        return await this.fetchFn(this.url(path), {
          method,
          headers: {
            ...headers,
            ...this.tenantHeaders(),
            accept: 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body && 'json' in body ? { 'content-type': 'application/json' } : {}),
          },
          body: body ? ('json' in body ? JSON.stringify(body.json) : body.form) : undefined,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };

    let res = await call(authenticated ? this.options.accessToken() : null);
    if (res.status === 401 && authenticated) {
      // Jeton expiré : un seul renouvellement, puis on rejoue la requête.
      const fresh = await this.options.refresh();
      if (!fresh) throw new ApiError(401, 'Session expirée : reconnectez-vous.');
      res = await call(fresh);
    }
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) throw new ApiError(res.status, errorMessage(res.status, json));
    return json as T;
  }
}

export function errorMessage(status: number, json: unknown): string {
  if (status === 413) return 'Fichier trop lourd (5 Mo au plus).';
  const message = (json as { message?: unknown } | null)?.message;
  if (Array.isArray(message)) return message.join(', ');
  if (typeof message === 'string') return message;
  if (status === 403) return "Votre compte n'a pas accès à cette fonction.";
  if (status >= 500) return 'Le service est momentanément indisponible. Réessayez.';
  return `Erreur ${status}`;
}
