// The three Arcium hubs and the addresses their pages are served from. Client-safe (no
// server imports): the sign-in page uses it to send people back to a hub after signing in.
//
// The hub pages are static; they call this app's /api/hubs/... with the Arcium session.
// They share the arciumsignals.com site with the app, so the (SameSite=Lax) session cookie
// travels with those requests; CORS admits only these origins.

export type HubId = 'data' | 'broker' | 'seed';

export const HUBS: Record<HubId, { name: string; origin: string; localPort: number; expects: string }> = {
  data: { name: 'Data Hub', origin: 'https://datahub.arciumsignals.com', localPort: 8091, expects: 'source_api.py' },
  broker: { name: 'Broker Hub', origin: 'https://brokerhub.arciumsignals.com', localPort: 8092, expects: 'broker_api.py' },
  seed: { name: 'Seed Hub', origin: 'https://seedhub.arciumsignals.com', localPort: 8093, expects: 'a seed package folder' },
};

export const isHubId = (s: string): s is HubId => s === 'data' || s === 'broker' || s === 'seed';

/** Origins whose pages may call the hub API: the three hubs, their local ports on
 *  localhost/127.0.0.1 outside production, and HUB_EXTRA_ORIGINS (comma-separated). */
export function hubOrigins(extra = '', production = true): string[] {
  const out = Object.values(HUBS).map(h => h.origin);
  if (!production) {
    for (const h of Object.values(HUBS)) out.push(`http://localhost:${h.localPort}`, `http://127.0.0.1:${h.localPort}`);
  }
  return [...out, ...extra.split(',').map(s => s.trim()).filter(Boolean)];
}

/** A sign-in ?next= target that is safe to follow: an http(s) address on one of the hubs. */
export function safeHubNext(next: string | null, production = true): string | null {
  if (!next) return null;
  try {
    const u = new URL(next);
    return hubOrigins('', production).includes(u.origin) ? u.toString() : null;
  } catch { return null; }
}
