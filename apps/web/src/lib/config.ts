import 'server-only';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variable d'environnement ${name} manquante`);
  return value;
}

export const config = {
  get apiUrl() {
    return required('API_URL').replace(/\/$/, '');
  },
  get sessionSecret() {
    const secret = required('SESSION_SECRET');
    if (secret.length < 32) throw new Error('SESSION_SECRET doit faire au moins 32 caractères');
    return secret;
  },
  get keycloakInternalUrl() {
    return process.env.KEYCLOAK_INTERNAL_URL?.replace(/\/$/, '') || null;
  },
};
