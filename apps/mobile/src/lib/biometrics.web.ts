/** Pas de biométrie dans l'aperçu web. */
export async function biometricsAvailable(): Promise<boolean> {
  return false;
}

export async function confirmIdentity(_reason: string): Promise<boolean> {
  return true;
}
