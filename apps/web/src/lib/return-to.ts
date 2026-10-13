/** Chemin de retour après connexion : uniquement un chemin interne au portail. */
export function safeReturnTo(value: string | null | undefined, fallback = '/espace'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  return value;
}
