/**
 * Une seule exécution à la fois : les appels concurrents partagent le même
 * résultat. Indispensable au renouvellement du jeton, que Keycloak n'accepte
 * qu'une fois (rotation du refresh token).
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  return () => {
    running ??= fn().finally(() => {
      running = null;
    });
    return running;
  };
}

/** Faut-il redemander l'empreinte au retour au premier plan ? */
export function shouldLock(backgroundSince: number | null, now: number, lockAfterMs: number): boolean {
  return backgroundSince !== null && now - backgroundSince >= lockAfterMs;
}
