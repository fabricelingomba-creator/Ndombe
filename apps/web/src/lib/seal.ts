import { EncryptJWT, jwtDecrypt } from 'jose';

/**
 * Chiffre une petite charge utile pour un cookie (JWE, AES-256-GCM).
 * Le contenu n'est ni lisible ni modifiable par le navigateur.
 */
async function keyFrom(secret: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return new Uint8Array(digest);
}

export async function seal(payload: Record<string, unknown>, secret: string, ttlSeconds: number): Promise<string> {
  return new EncryptJWT(payload)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .encrypt(await keyFrom(secret));
}

export async function unseal<T extends Record<string, unknown>>(token: string | undefined, secret: string): Promise<T | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtDecrypt(token, await keyFrom(secret));
    return payload as T;
  } catch {
    return null;
  }
}
