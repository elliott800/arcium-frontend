'use client';

// Public pages: the frame (bar, logo, actions) and the card every signed-out page uses, plus the site info hook.

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import t from './theme.module.css';

export const BASE = '';

export interface SiteInfo {
  mode: 'live' | 'demo'; signup_open: boolean; demo_url: string | null;
  test_sessions?: boolean; test_session_hours?: number;
}

/** Which deployment this is (live = owner only, demo = throwaway test sessions). */
export function useSiteInfo(): SiteInfo | null {
  const [info, setInfo] = useState<SiteInfo | null>(null);
  useEffect(() => {
    fetch(`${BASE}/api/site-info`).then(r => r.json()).then(setInfo).catch(() => {});
  }, []);
  return info;
}

/** POST JSON; resolves to { ok, status, data } and never throws. */
export async function postJson(path: string, body: unknown) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, status: 0, data: { error: 'Unable to reach the server.' } };
  }
}

/** Page frame in the Discord hub style: header bar (brand left, actions right) and a centered column. */
export function Shell({ actions, children }: { actions?: ReactNode; children: ReactNode }) {
  const info = useSiteInfo();
  return (
    <div className={t.page}>
      <header className={t.bar}>
        <div className={t.wrap}>
          <Link className={t.brand} href="/">
            <img className={t.brandLogo} src={`${BASE}/arcium-signals-logo.png`} alt="Arcium Signals" width="1195" height="233" />
            {info?.mode === 'demo' && <span className={t.hubName}>Demo</span>}
          </Link>
          <div className={t.barActions}>{actions}</div>
        </div>
      </header>
      <main className={t.wrap}>{children}</main>
    </div>
  );
}

/** The centered card with the Arcium logo banner used by every sign-in style page. */
export function AuthCard({ title, intro, children }: { title: string; intro?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`${t.card} ${t.login}`}>
      <div className={t.logos}>
        <img className={t.logoArcium} src={`${BASE}/arcium-signals-logo.png`} alt="Arcium Signals" width="1195" height="233" />
      </div>
      <h1>{title}</h1>
      {intro && <p>{intro}</p>}
      {children}
    </div>
  );
}
