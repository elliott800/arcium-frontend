'use client';

// Passkeys in the browser (server side: src/lib/passkeys.ts). Both return { ok, data } like postJson.

import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { BASE, postJson } from './Shell';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the routes' JSON replies differ per call
type Result = { ok: boolean; data: Record<string, any> };

const cancelled = (e: unknown) => e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'AbortError');

export const passkeysSupported = () => typeof window !== 'undefined' && browserSupportsWebAuthn();

/** Sign in with a key this device holds for the site. */
export async function passkeySignIn(): Promise<Result> {
  const opts = await postJson('/api/passkey/login/options', {});
  if (!opts.ok) return opts;
  let response;
  try {
    response = await startAuthentication({ optionsJSON: opts.data as never });
  } catch (e) {
    return { ok: false, data: { error: cancelled(e) ? '' : 'This device could not use a key here.' } };
  }
  return postJson('/api/passkey/login/verify', { response });
}

/** Save a key for the signed-in account on this device. */
export async function passkeySave(name: string): Promise<Result> {
  const opts = await postJson('/api/passkey/register/options', {});
  if (!opts.ok) return opts;
  let response;
  try {
    response = await startRegistration({ optionsJSON: opts.data as never });
  } catch (e) {
    const already = e instanceof Error && e.name === 'InvalidStateError';
    return { ok: false, data: { error: already ? 'This device already holds a key for your account.' : cancelled(e) ? '' : 'This device could not save a key.' } };
  }
  return postJson('/api/passkey/register/verify', { response, name });
}

export async function passkeyList(): Promise<{ id: string; name: string; admin_approved: boolean; created_at: string; last_used_at: string | null }[]> {
  const r = await fetch(`${BASE}/api/passkey`);
  return r.ok ? (await r.json()).keys : [];
}

export async function passkeyRemove(id: string): Promise<boolean> {
  const r = await fetch(`${BASE}/api/passkey`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  return r.ok && (await r.json()).ok;
}

/** A name for the key from the device, e.g. "Windows · Chrome". */
export function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Mac/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${os} · ${br}`;
}
