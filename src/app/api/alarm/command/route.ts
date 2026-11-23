// API (hook, ArciumAlarm phone app): a spoken or typed command becomes calendar actions.

import { type NextRequest, NextResponse } from 'next/server';
import { isDemo } from '@/lib/site-mode';
import { rateLimit } from '@/lib/signup';
import { AlarmClaudeError, bearer, deviceUser, planCalendarChanges } from '@/lib/alarm';

const MAX_BODY = 200_000;

// body: { command, now, timezone, default_calendar_id, calendars[], events[] }
//   -> { reply, actions[] } : the phone applies the actions to its calendar itself.
// Auth: "Authorization: Bearer <device token>" from /api/alarm/login.
export async function POST(req: NextRequest) {
  if (isDemo) return NextResponse.json({ error: 'Not here.' }, { status: 404 });
  const user = await deviceUser(bearer(req));
  if (!user) return NextResponse.json({ error: 'Signed out. Sign in again in the app.', code: 'NOT_SIGNED_IN' }, { status: 401 });

  // Each command spends API credits; cap a leaked or misbehaving device.
  if (!rateLimit(`alarm:${user.user_id}:m`, 10, 60_000) || !rateLimit(`alarm:${user.user_id}:d`, 300, 24 * 3600_000)) {
    return NextResponse.json({ error: 'Rate limit reached, try again later.' }, { status: 429 });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY) return NextResponse.json({ error: 'Request too large.' }, { status: 413 });
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: 'Bad JSON.' }, { status: 400 }); }
  const command = String(body.command ?? '').trim().slice(0, 1000);
  if (!command) return NextResponse.json({ error: 'Missing command.' }, { status: 400 });

  try {
    const out = await planCalendarChanges(command, {
      now: body.now ?? '',
      timezone: body.timezone ?? '',
      default_calendar_id: body.default_calendar_id ?? '',
      calendars: Array.isArray(body.calendars) ? body.calendars : [],
      events: Array.isArray(body.events) ? body.events : [],
    });
    return NextResponse.json(out);
  } catch (err) {
    if (err instanceof AlarmClaudeError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error('[alarm] command failed:', err);
    return NextResponse.json({ error: 'Server error.' }, { status: 500 });
  }
}
