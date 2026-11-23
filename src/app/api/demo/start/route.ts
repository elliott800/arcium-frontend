// Demo site: start a throwaway test session (see src/lib/demo.ts).

import { type NextRequest, NextResponse } from 'next/server';
import { createSession, setSessionCookie } from '@/lib/auth';
import { TEST_SESSIONS } from '@/lib/site-mode';
import { createDemoUser, DemoUnavailable } from '@/lib/demo';
import { clientIp, rateLimit } from '@/lib/signup';

export async function POST(req: NextRequest) {
  if (!TEST_SESSIONS) return NextResponse.json({ error: 'Test sessions are off.' }, { status: 404 });
  if (!rateLimit(`demo-start:${clientIp(req)}`, 10, 60 * 60_000)) {
    return NextResponse.json({ error: 'Too many test sessions from here. Try again in an hour.' }, { status: 429 });
  }
  try {
    const demo = await createDemoUser();
    const token = await createSession(demo.user_id, req.headers.get('user-agent'));
    const res = NextResponse.json({ ok: true, username: demo.username, expires_at: demo.expires_at });
    setSessionCookie(res, token);
    return res;
  } catch (err) {
    if (err instanceof DemoUnavailable) return NextResponse.json({ error: err.message }, { status: 503 });
    throw err;
  }
}
