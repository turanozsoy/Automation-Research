import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Envelope encryption for storageState blobs.
 *   master key (env PROFILE_MASTER_KEY, 32 bytes base64)  ->  wraps a random per-profile data key
 *   data key  ->  AES-256-GCM over the storageState JSON, with the profile id as associated data
 * Rotating the master key only re-wraps the small data keys.
 *
 * Development convenience: without PROFILE_MASTER_KEY a key is generated once into
 * <dataDir>/master.key (gitignored). Production must supply the env var / a secret store.
 */
export interface Encrypted { ciphertext: Buffer; nonce: Buffer; dataKeyEnc: Buffer; keyVersion: number }

export class Vault {
  private constructor(private master: Buffer) {}

  static load(dataDir: string): Vault {
    const env = process.env.PROFILE_MASTER_KEY;
    if (env) {
      const key = Buffer.from(env, 'base64');
      if (key.length !== 32) throw new Error('PROFILE_MASTER_KEY must be 32 bytes, base64 encoded');
      return new Vault(key);
    }
    const file = resolve(dataDir, 'master.key');
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
      console.warn(`[vault] generated development master key at ${file} (set PROFILE_MASTER_KEY in production)`);
    }
    const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error(`${file} does not contain a 32-byte base64 key`);
    return new Vault(key);
  }

  encrypt(profileId: string, plaintext: string): Encrypted {
    const dataKey = randomBytes(32);
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', dataKey, nonce);
    c.setAAD(Buffer.from(profileId));
    const ciphertext = Buffer.concat([c.update(plaintext, 'utf8'), c.final(), c.getAuthTag()]);
    return { ciphertext, nonce, dataKeyEnc: this.wrap(dataKey), keyVersion: 1 };
  }

  decrypt(profileId: string, e: Encrypted): string {
    const dataKey = this.unwrap(e.dataKeyEnc);
    const tag = e.ciphertext.subarray(e.ciphertext.length - 16);
    const body = e.ciphertext.subarray(0, e.ciphertext.length - 16);
    const d = createDecipheriv('aes-256-gcm', dataKey, e.nonce);
    d.setAAD(Buffer.from(profileId));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString('utf8');
  }

  /** A key derived from the master for another purpose (e.g. signing operator sessions); never the master itself. */
  derive(label: string): Buffer {
    return createHmac('sha256', this.master).update(`derive:${label}`).digest();
  }

  private wrap(dataKey: Buffer): Buffer {
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.master, nonce);
    return Buffer.concat([nonce, c.update(dataKey), c.final(), c.getAuthTag()]);
  }

  private unwrap(blob: Buffer): Buffer {
    const nonce = blob.subarray(0, 12);
    const tag = blob.subarray(blob.length - 16);
    const body = blob.subarray(12, blob.length - 16);
    const d = createDecipheriv('aes-256-gcm', this.master, nonce);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]);
  }
}
