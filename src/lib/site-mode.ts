// Which deployment this process is.
//
//   live  the real site on the real database: only admins (the owner) may sign in.
//   demo  the demo site on its own demo database of simulated systems: approved
//         users sign up and sign in here. It never talks to real machines.
//
// The two are separate processes with separate DATABASE_URLs, so a demo
// session can never reach real data. Set ARCIUM_SITE_MODE=demo on the demo
// deployment; anything else is live.
export type SiteMode = 'live' | 'demo';

export const SITE_MODE: SiteMode = process.env.ARCIUM_SITE_MODE === 'demo' ? 'demo' : 'live';

export const isDemo = SITE_MODE === 'demo';

/** The sign-in page's User button: a throwaway test session on simulated systems (src/lib/demo.ts), on the live
 *  site too since the demo site was retired (Nov 23, 2026). ARCIUM_TEST_SESSIONS=false turns it off. */
export const TEST_SESSIONS = isDemo || process.env.ARCIUM_TEST_SESSIONS !== 'false';

/** Arcium account sign-up, off unless ARCIUM_SIGNUP_OPEN=true. On the live
 *  site this makes the one Arcium account used across every Arcium site (see
 *  src/lib/sso.ts); it still only reaches the portal if it's the owner's. The
 *  demo normally uses throwaway test sessions instead (src/lib/demo.ts). */
export const SIGNUP_OPEN = process.env.ARCIUM_SIGNUP_OPEN === 'true';

/** Where people without the owner's account go (the demo site's sign-in). */
export const DEMO_SITE_URL = process.env.DEMO_SITE_URL ?? '';
