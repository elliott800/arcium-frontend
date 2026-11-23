// The Data Hub host's origin, as in src/lib/hosts.ts (kept import-free so the unit tests can load this file).

import { createHmac, timingSafeEqual } from 'crypto';
const DATAHUB_ORIGIN = (process.env.DATAHUB_ORIGIN?.trim() || 'https://datahub.arciumsignals.com').replace(/\/$/, '');
// The Services Hub and Arcade hosts this app serves (src/lib/hosts.ts); locally they are *.localhost.
const SERVICES_ORIGIN = (process.env.SERVICES_ORIGIN?.trim() || 'https://serviceshub.arciumsignals.com').replace(/\/$/, '');
const ARCADE_ORIGIN = (process.env.ARCADE_ORIGIN?.trim() || 'https://arcade.arciumsignals.com').replace(/\/$/, '');

// Single sign-on: app.arciumsignals.com holds the one Arcium account, and the
// other Arcium sites (Fusion Hub, the Arcade, ...) sign people in through it.
//
//   1. The site sends the browser to  /sso?client=<id>&return=<page>&state=<random>
//   2. Once signed in here, /api/sso/pass makes a short-lived pass signed with
//      that client's secret, and the browser goes back to
//      <page>#arcium_pass=<pass>&state=<random>  (a fragment, so the pass never
//      reaches a server log).
//   3. The site checks the signature, the audience and the expiry with the
//      same secret, then signs the person in to its own session.
//
// Each client has a shared secret in this site's environment
// (SSO_SECRET_<ID>, e.g. SSO_SECRET_FUSIONHUB) and a fixed list of origins a
// pass may be sent to. SSO_EXTRA_ORIGINS (comma-separated) adds origins for
// local testing.

export const PASS_SECONDS = 120;

interface Client { id: string; origins: string[] }

const CLIENTS: Record<string, Client> = {
  fusionhub: {
    id: 'fusionhub',
    // The Arcade runs inside Fusion Hub, so it signs in as the same client.
    origins: [...new Set(['https://fusionhub.arciumfinancial.com', 'https://arcade.arciumsignals.com',
      'https://serviceshub.arciumsignals.com', SERVICES_ORIGIN, ARCADE_ORIGIN])],
  },
  discordhub: {
    id: 'discordhub',
    // The Discord Hub admin page; it lets in only passes whose role is admin (the owner).
    origins: ['https://discordhub.arciumsignals.com'],
  },
  arciumsites: {
    id: 'arciumsites',
    // The Arcium Sites client portal; the pass's email is the client account it signs in to.
    origins: ['https://www.arciumsites.com', 'https://arciumsites.com'],
  },
  datahub: {
    id: 'datahub',
    // The Data Hub at datahub.arciumsignals.com: this same app on another host. It takes the pass at /api/sso/accept
    // (admins only) and gives the browser a session on that host.
    origins: [DATAHUB_ORIGIN],
  },
  leadgen: {
    id: 'leadgen',
    // The lead generator; it lets in only passes whose role is admin (the owner).
    origins: ['https://leadgenerator.arciumsites.com'],
  },
};

function secretFor(id: string): string | null {
  const s = process.env[`SSO_SECRET_${id.toUpperCase()}`] ?? '';
  return s.length >= 32 ? s : null;
}

/** The client and the validated return URL, or an error message. */
export function checkRequest(clientId: unknown, returnTo: unknown): { client: Client; url: URL } | { error: string } {
  const client = CLIENTS[String(clientId ?? '')];
  if (!client || !secretFor(client.id)) return { error: 'Unknown site.' };
  let url: URL;
  try { url = new URL(String(returnTo ?? '')); } catch { return { error: 'Bad return address.' }; }
  const extra = (process.env.SSO_EXTRA_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (![...client.origins, ...extra].includes(url.origin)) return { error: 'That site may not sign in with Arcium.' };
  url.hash = '';
  return { client, url };
}

export interface PassUser { user_id: string; username: string; email: string; phone: string | null; role: string }

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** payload.signature, both base64url; the signature is HMAC-SHA256 over the payload part. */
export function makePass(client: Client, user: PassUser, state: string): string {
  const now = Math.floor(Date.now() / 1000);
  const body = b64(JSON.stringify({
    iss: 'arcium', aud: client.id, sub: user.user_id, username: user.username, email: user.email,
    phone: user.phone, role: user.role, email_verified: true, iat: now, exp: now + PASS_SECONDS, state: state.slice(0, 128),
  }));
  const sig = createHmac('sha256', secretFor(client.id)!).update(body).digest();
  return `${body}.${b64(sig)}`;
}

export interface PassPayload {
  iss: string; aud: string; sub: string; username: string; email: string; phone: string | null; role: string;
  email_verified: boolean; iat: number; exp: number; state: string;
}

/** Checks a pass made by makePass for this client: signature (constant time), audience and expiry. */
export function verifyPass(clientId: string, pass: string): PassPayload | null {
  const secret = secretFor(clientId);
  const [body, sig] = String(pass ?? '').split('.');
  if (!secret || !body || !sig) return null;
  const want = createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let p: PassPayload;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (p.iss !== 'arcium' || p.aud !== clientId || !p.sub || typeof p.exp !== 'number' || p.exp < now || p.iat > now + 60) return null;
  return p;
}
