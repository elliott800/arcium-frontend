// Credentials at rest: AES-256-GCM with a key from ARCIUM_SECRET_KEY
// (32 bytes, hex or base64). Settings JSON stored or relayed by the site never
// carries these fields; they live encrypted in the `credentials` table.

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

export const SECRET_FIELDS = new Set([
  'api_key', 'api_secret', 'api_token', 'access_token', 'account_id', 'password', 'secret', 'token',
]);

function key(): Buffer {
  const raw = process.env.ARCIUM_SECRET_KEY ?? '';
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error('ARCIUM_SECRET_KEY must be set to 32 bytes (64 hex chars or base64) to store credentials');
  }
  return buf;
}

export function hasSecretKey(): boolean {
  try { key(); return true; } catch { return false; }
}

export interface Sealed { ciphertext: string; iv: string; tag: string }

export function seal(value: unknown): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { ciphertext: ct.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

export function open<T = unknown>(s: Sealed): T {
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(s.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(s.tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(s.ciphertext, 'base64')), decipher.final()]);
  return JSON.parse(pt.toString('utf8')) as T;
}

/** Split a settings object into (settings without secrets, non-empty secret values).
 *  Secret keys are matched at any depth; nested secrets are keyed by dotted path. */
export function splitSecrets(obj: unknown): { clean: Record<string, unknown>; secrets: Record<string, string> } {
  const secrets: Record<string, string> = {};
  const walk = (node: unknown, prefix: string): unknown => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (SECRET_FIELDS.has(k.toLowerCase()) && (typeof v === 'string' || typeof v === 'number')) {
        if (String(v).trim()) secrets[p] = String(v);
        continue;
      }
      out[k] = walk(v, p);
    }
    return out;
  };
  const clean = (walk(obj, '') ?? {}) as Record<string, unknown>;
  return { clean, secrets };
}

/** Put dotted-path secrets back into a settings object (machine side uses the same shape). */
export function mergeSecrets(obj: Record<string, unknown>, secrets: Record<string, string>): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(obj ?? {}));
  for (const [path, value] of Object.entries(secrets)) {
    const parts = path.split('.');
    let node = out;
    for (const p of parts.slice(0, -1)) {
      if (!node[p] || typeof node[p] !== 'object') node[p] = {};
      node = node[p];
    }
    node[parts[parts.length - 1]] = value;
  }
  return out;
}

/** Strip secrets from a JSON string (for rows the site stores or relays). */
export function stripSecretsJson(text: string | null | undefined): string | null | undefined {
  if (!text) return text;
  try {
    return JSON.stringify(splitSecrets(JSON.parse(text)).clean);
  } catch {
    return text;
  }
}
