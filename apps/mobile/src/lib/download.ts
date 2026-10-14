import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { ApiClient } from './api';

/**
 * Télécharge un PDF protégé (relevé officiel) dans le cache de l'app puis
 * ouvre la feuille de partage du système (enregistrer, imprimer, envoyer).
 */
export async function downloadAndShare(api: ApiClient, path: string, filename: string): Promise<void> {
  const target = new File(Paths.cache, filename);
  const attempt = async (fresh: boolean) =>
    File.downloadFileAsync(api.url(path), target, { headers: { ...(await api.authHeaders(fresh)), accept: 'application/pdf' }, idempotent: true });
  let file: File;
  try {
    file = await attempt(false);
  } catch (err) {
    if (!/401/.test((err as Error).message)) throw err;
    file = await attempt(true);
  }
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: filename });
  }
}
