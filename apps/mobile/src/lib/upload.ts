/** Fichier choisi sur le téléphone (photo, scan, PDF). */
export interface PickedFile {
  uri: string;
  name: string;
  mimeType: string;
  size: number | null;
}

/** Sur iOS et Android, FormData accepte directement l'URI locale du fichier. */
export async function appendFile(form: FormData, field: string, file: PickedFile): Promise<void> {
  form.append(field, { uri: file.uri, name: file.name, type: file.mimeType } as unknown as Blob);
}
