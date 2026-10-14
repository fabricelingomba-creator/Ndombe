import type { Manifest, Me } from '@elongo/shared/types';
import * as Network from 'expo-network';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { ApiClient, ApiError } from '@/lib/api';
import { biometricsAvailable, confirmIdentity } from '@/lib/biometrics';
import { API_URL, LOCK_AFTER_MS } from '@/lib/config';
import { enqueue, flushOutbox, isNetworkFailure, QueuedAction, readThrough } from '@/lib/offline';
import * as oidc from '@/lib/oidc';
import { secure } from '@/lib/secure';
import { shouldLock, singleFlight } from '@/lib/single-flight';
import { store } from '@/lib/store';
import { parseTenantInput } from '@/lib/tenant';

export interface Tenant {
  slug: string;
  name: string;
  issuer: string;
  primaryColor: string;
  secondaryColor: string;
  logoUrl: string | null;
  /** Portail web : retour après paiement, tâches du personnel. */
  portalUrl: string;
}

export type Status = 'loading' | 'no-tenant' | 'signed-out' | 'locked' | 'ready';

interface SessionValue {
  status: Status;
  tenant: Tenant | null;
  me: Me | null;
  online: boolean;
  api: ApiClient | null;
  biometrics: { available: boolean; enabled: boolean };
  chooseTenant(input: string): Promise<void>;
  signIn(): Promise<boolean>;
  unlock(): Promise<void>;
  signOut(): Promise<void>;
  forgetTenant(): Promise<void>;
  setBiometricsEnabled(enabled: boolean): Promise<void>;
  /** Action sans enjeu : envoyée tout de suite, ou mise en attente sans réseau. */
  sendOrQueue(action: QueuedAction): Promise<void>;
  /** Clé de cache propre à l'université et au compte. */
  cacheKey(name: string): string;
}

const SessionContext = createContext<SessionValue | null>(null);

const KEYS = { tenant: 'tenant', refresh: 'refresh_token', biometrics: 'biometrics' } as const;

function tenantFrom(manifest: Manifest): Tenant {
  return {
    slug: manifest.slug,
    name: manifest.name,
    issuer: manifest.auth.issuer,
    primaryColor: manifest.branding?.primaryColor ?? '#1D4ED8',
    secondaryColor: manifest.branding?.secondaryColor ?? '#F59E0B',
    logoUrl: manifest.branding?.logoUrl ?? null,
    portalUrl: manifest.portalUrl,
  };
}

/** Le jeton de renouvellement a été refusé (révoqué, expiré) : il faut se reconnecter. */
function isRejectedGrant(err: unknown): boolean {
  return !isNetworkFailure(err);
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [online, setOnline] = useState(true);
  const [biometrics, setBiometrics] = useState({ available: false, enabled: false });
  const access = useRef<{ token: string; expiresAt: number } | null>(null);
  const tenantRef = useRef<Tenant | null>(null);
  const backgroundSince = useRef<number | null>(null);

  tenantRef.current = tenant;

  const clearLocal = useCallback(async () => {
    access.current = null;
    await secure.delete(KEYS.refresh);
    // Les copies hors ligne contiennent des données personnelles : rien ne reste après la déconnexion.
    await store.clear();
    setMe(null);
  }, []);

  const refreshTokens = useMemo(
    () =>
      singleFlight(async (): Promise<string | null> => {
        const t = tenantRef.current;
        const refreshToken = await secure.get(KEYS.refresh);
        if (!t || !refreshToken) return null;
        try {
          const tokens = await oidc.refresh(t.issuer, refreshToken);
          if (tokens.refreshToken) await secure.set(KEYS.refresh, tokens.refreshToken);
          access.current = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
          return tokens.accessToken;
        } catch (err) {
          if (isRejectedGrant(err)) {
            await clearLocal();
            setStatus('signed-out');
            return null;
          }
          throw err;
        }
      }),
    [clearLocal],
  );

  const api = useMemo(
    () =>
      tenant
        ? new ApiClient({
            baseUrl: API_URL,
            tenant: { slug: tenant.slug },
            accessToken: () => access.current?.token ?? null,
            refresh: refreshTokens,
          })
        : null,
    [tenant, refreshTokens],
  );

  const cacheKey = useCallback((name: string) => `${tenantRef.current?.slug}:${me?.id ?? 'anon'}:${name}`, [me]);

  /** Renouvelle la session puis charge le profil ; sans réseau, reprend le dernier profil connu. */
  const resume = useCallback(
    async (client: ApiClient, t: Tenant) => {
      try {
        const token = await refreshTokens();
        if (!token) return;
      } catch (err) {
        if (!isNetworkFailure(err)) throw err;
      }
      const lastUser = await store.get(`last-user:${t.slug}`);
      try {
        const profile = await readThrough(store, `${t.slug}:${lastUser?.value ?? 'anon'}:me`, () => client.get<Me>('/v1/me'));
        await store.set(`last-user:${t.slug}`, profile.data.id, Date.now());
        setMe(profile.data);
        setStatus('ready');
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          await clearLocal();
          setStatus('signed-out');
          return;
        }
        throw err;
      }
    },
    [refreshTokens, clearLocal],
  );

  // Démarrage : université choisie ? session existante ? verrou biométrique ?
  useEffect(() => {
    (async () => {
      const available = await biometricsAvailable().catch(() => false);
      const enabled = available && (await secure.get(KEYS.biometrics)) === '1';
      setBiometrics({ available, enabled });
      const saved = await secure.get(KEYS.tenant);
      if (!saved) return setStatus('no-tenant');
      const t = JSON.parse(saved) as Tenant;
      setTenant(t);
      tenantRef.current = t;
      if (!(await secure.get(KEYS.refresh))) return setStatus('signed-out');
      if (enabled) return setStatus('locked');
      const client = new ApiClient({ baseUrl: API_URL, tenant: { slug: t.slug }, accessToken: () => access.current?.token ?? null, refresh: refreshTokens });
      await resume(client, t).catch(() => setStatus('signed-out'));
    })();
  }, [refreshTokens, resume]);

  // Retour au premier plan après un moment : on redemande l'empreinte.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') backgroundSince.current = Date.now();
      if (state === 'active') {
        if (biometrics.enabled && status === 'ready' && shouldLock(backgroundSince.current, Date.now(), LOCK_AFTER_MS)) {
          access.current = null;
          setStatus('locked');
        }
        backgroundSince.current = null;
      }
    });
    return () => sub.remove();
  }, [biometrics.enabled, status]);

  const flush = useCallback(async () => {
    if (!api || status !== 'ready') return;
    await flushOutbox(store, async (a) => {
      try {
        await api.post(a.path, a.body);
        return { ok: true, status: 200 };
      } catch (err) {
        if (err instanceof ApiError) return { ok: false, status: err.status };
        throw err;
      }
    }).catch(() => undefined);
  }, [api, status]);

  // Réseau : bandeau hors ligne, et rejeu de la file au retour de la connexion.
  useEffect(() => {
    Network.getNetworkStateAsync()
      .then((s) => setOnline(s.isConnected !== false))
      .catch(() => undefined);
    const sub = Network.addNetworkStateListener((s) => {
      const isOnline = s.isConnected !== false;
      setOnline(isOnline);
      if (isOnline) void flush();
    });
    return () => sub.remove();
  }, [flush]);

  useEffect(() => {
    if (status === 'ready') void flush();
  }, [status, flush]);

  const value: SessionValue = {
    status,
    tenant,
    me,
    online,
    api,
    biometrics,
    cacheKey,

    async chooseTenant(input) {
      const query = parseTenantInput(input);
      if (!query) throw new Error('Saisissez le code ou l’adresse du portail de votre université.');
      const probe = new ApiClient({
        baseUrl: API_URL,
        tenant: query.kind === 'slug' ? { slug: query.slug } : { host: query.host },
        accessToken: () => null,
        refresh: async () => null,
      });
      let manifest: Manifest;
      try {
        manifest = await probe.publicGet<Manifest>('/v1/tenant/manifest');
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) throw new Error('Aucune université ne correspond à cette saisie.');
        if (err instanceof ApiError && err.status === 403) throw new Error('Cette université est suspendue.');
        if (isNetworkFailure(err)) throw new Error('Pas de connexion internet.');
        throw err;
      }
      const t = tenantFrom(manifest);
      await secure.set(KEYS.tenant, JSON.stringify(t));
      setTenant(t);
      setStatus('signed-out');
    },

    async signIn() {
      const t = tenantRef.current;
      if (!t || !api) return false;
      const tokens = await oidc.signIn(t.issuer);
      if (!tokens) return false;
      access.current = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
      if (tokens.refreshToken) await secure.set(KEYS.refresh, tokens.refreshToken);
      const profile = await api.get<Me>('/v1/me');
      await store.set(`last-user:${t.slug}`, profile.id, Date.now());
      await store.set(`cache:${t.slug}:${profile.id}:me`, JSON.stringify(profile), Date.now());
      setMe(profile);
      setStatus('ready');
      return true;
    },

    async unlock() {
      const t = tenantRef.current;
      if (!t || !api) return;
      if (!(await confirmIdentity(`Déverrouiller ${t.name}`))) return;
      await resume(api, t);
    },

    async signOut() {
      const t = tenantRef.current;
      const refreshToken = await secure.get(KEYS.refresh);
      if (t && refreshToken) await oidc.revoke(t.issuer, refreshToken);
      await clearLocal();
      setStatus('signed-out');
    },

    async forgetTenant() {
      await value.signOut();
      await secure.delete(KEYS.tenant);
      setTenant(null);
      setStatus('no-tenant');
    },

    async setBiometricsEnabled(enabled) {
      if (enabled && !(await confirmIdentity('Activer le déverrouillage biométrique'))) return;
      await secure.set(KEYS.biometrics, enabled ? '1' : '0');
      setBiometrics((b) => ({ ...b, enabled }));
    },

    async sendOrQueue(action) {
      if (!api) return;
      try {
        await api.post(action.path, action.body);
      } catch (err) {
        if (!isNetworkFailure(err)) throw err;
        await enqueue(store, action);
      }
    },
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession hors de SessionProvider');
  return ctx;
}
