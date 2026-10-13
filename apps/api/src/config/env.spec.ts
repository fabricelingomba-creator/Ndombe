import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from './env';

describe('loadEnv', () => {
  it("accepte le fichier .env.example tel quel", () => {
    const example = Object.fromEntries(
      readFileSync(join(__dirname, '..', '..', '.env.example'), 'utf8')
        .split('\n')
        .filter((line) => /^[A-Z_]+=/.test(line))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    const env = loadEnv(example);
    expect(env.KEYCLOAK_ADMIN_CLIENT_ID).toBeUndefined();
    expect(env.KEYCLOAK_ADMIN_CLIENT_SECRET).toBeUndefined();
  });

  it('signale une variable obligatoire manquante', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });
});
