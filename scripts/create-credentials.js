import { generateKeyPairSync, randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function generateCredentials() {
  const password = randomBytes(32).toString('base64url');
  const salt = randomBytes(24);
  const hash = scryptSync(password, salt, 64);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { password, passwordHash: `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`,
    jwks: { keys: [{ ...privateKey.export({ format: 'jwk' }), kid: randomBytes(16).toString('hex'), alg: 'RS256', use: 'sig' }] },
    cookieKeys: [randomBytes(48).toString('base64url'), randomBytes(48).toString('base64url')] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  if (!directory) throw new Error('Supply an explicit private credential directory outside Git');
  if (existsSync(join(directory, 'password-hash'))) throw new Error('Credentials already exist; refusing to replace them');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const credentials = generateCredentials();
  const files = {
    'login.txt': credentials.password + '\n', 'password-hash': credentials.passwordHash + '\n',
    'jwks.json': JSON.stringify(credentials.jwks) + '\n', 'cookie-keys.json': JSON.stringify(credentials.cookieKeys) + '\n'
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content, { mode: 0o600, flag: 'wx' });
  console.log('Private credentials created. No credential values are printed.');
}
