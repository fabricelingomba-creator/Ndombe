import type { PickedFile } from './upload';

export type { PickedFile } from './upload';

/** Dans le navigateur, l'URI est une adresse blob: qu'il faut relire. */
export async function appendFile(form: FormData, field: string, file: PickedFile): Promise<void> {
  const blob = await (await fetch(file.uri)).blob();
  form.append(field, new Blob([blob], { type: file.mimeType }), file.name);
}
