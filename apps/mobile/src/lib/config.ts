/** Adresse de l'API Elongo ; à fixer par build (EXPO_PUBLIC_API_URL). */
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'https://api.elongo.app';

/** Client Keycloak public créé dans le realm de chaque université (PKCE). */
export const CLIENT_ID = 'elongo-mobile';
export const NATIVE_REDIRECT_URI = 'elongo://auth/callback';

/** Après ce temps en arrière-plan, l'app redemande l'empreinte ou le visage. */
export const LOCK_AFTER_MS = 5 * 60_000;
