// The hosts this one Next app answers on.
//   app.arciumsignals.com      the site (APP_ORIGIN); it holds the Arcium account and single sign-on
//   datahub.arciumsignals.com  the Data Hub page at its root (DATAHUB_ORIGIN); people sign in through the app's single
//                              sign-on (client 'datahub', src/lib/sso.ts) and get a session on this host
// nginx sends datahub.arciumsignals.com to this app, except the hub server's own /status, /healthz and /about pages.
// For the Arcium test site: APP_ORIGIN=http://app.localhost:3005 and DATAHUB_ORIGIN=http://datahub.localhost:3005
// (*.localhost reaches the laptop in every browser).

const origin = (v: string | undefined, fallback: string) => (v && v.trim() ? v.trim() : fallback).replace(/\/$/, '');

export const APP_ORIGIN = origin(process.env.APP_ORIGIN, 'https://app.arciumsignals.com');
export const DATAHUB_ORIGIN = origin(process.env.DATAHUB_ORIGIN, 'https://datahub.arciumsignals.com');

const hostname = (o: string) => { try { return new URL(o).hostname.toLowerCase(); } catch { return ''; } };
const reqHostname = (host: string | null) => (host ?? '').toLowerCase().replace(/:\d+$/, '');

export const isDatahubHost = (host: string | null) => reqHostname(host) === hostname(DATAHUB_ORIGIN);
export const isAppHost = (host: string | null) => reqHostname(host) === hostname(APP_ORIGIN);

// The Services Hub and the Arcade (src/proxy.ts servicesHost): their pages (public/services/) are served here; their
// /v1 API is the Services Hub service (Fusion Hub, Python), reached by nginx in production, by SERVICES_API_URL when
// set, and by the simulated one (src/lib/sim-services.ts) under `npm run sim`.
//   serviceshub.arciumsignals.com  the Services Hub front page, /trader and /arcade (SERVICES_ORIGIN)
//   arcade.arciumsignals.com       the Arcade at its root (ARCADE_ORIGIN)
export const SERVICES_ORIGIN = origin(process.env.SERVICES_ORIGIN, 'https://serviceshub.arciumsignals.com');
export const ARCADE_ORIGIN = origin(process.env.ARCADE_ORIGIN, 'https://arcade.arciumsignals.com');
export const isServicesHost = (host: string | null) => reqHostname(host) === hostname(SERVICES_ORIGIN);
export const isArcadeHost = (host: string | null) => reqHostname(host) === hostname(ARCADE_ORIGIN);
