import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Chiffrement des secrets des prestataires (clés API, secrets de webhook) avec
 * AES-256-GCM. La clé vient de l'environnement, jamais de la base : une copie
 * de la base seule ne révèle aucun secret.
 * Format : v1.<iv>.<tag>.<texte chiffré>, en base64url. L'université et le
 * prestataire sont liés comme données authentifiées : un secret copié d'une
 * université à l'autre ne se déchiffre pas.
 */
export function sealSecrets(key: Buffer, context: string, secrets: Record<string, string>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), body].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function openSecrets(key: Buffer, context: string, sealed: string): Record<string, string> {
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('Secrets illisibles');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const plain = Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as Record<string, string>;
}
