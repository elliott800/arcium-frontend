// The address a visitor used to reach this app, for links handed back to them. Behind nginx the app listens on
// 127.0.0.1:3004, so req.nextUrl.origin reads as https://localhost:3004; nginx forwards the real host
// (Host / X-Forwarded-Host) and scheme (X-Forwarded-Proto). The app serves several hosts (app., datahub., demo.),
// so the host comes from the request, not from SITE_URL.

import type { NextRequest } from 'next/server';

const HOST = /^[a-z0-9.-]+(:\d{1,5})?$/i;

export function publicOrigin(req: NextRequest): string {
  const host = (req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '').split(',')[0].trim();
  if (!host || !HOST.test(host)) return req.nextUrl.origin;
  const fwd = (req.headers.get('x-forwarded-proto') ?? '').split(',')[0].trim();
  const proto = fwd === 'http' || fwd === 'https' ? fwd : req.nextUrl.protocol.replace(':', '');
  return `${proto}://${host}`;
}
