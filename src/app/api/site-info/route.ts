// Public: lets the sign-in pages know which deployment they're on.

import { NextResponse } from 'next/server';
import { SITE_MODE, DEMO_SITE_URL, SIGNUP_OPEN, isDemo } from '@/lib/site-mode';
import { DEMO_SESSION_HOURS } from '@/lib/demo';

export async function GET() {
  return NextResponse.json({
    mode: SITE_MODE, signup_open: SIGNUP_OPEN, demo_url: DEMO_SITE_URL || null,
    test_sessions: isDemo, test_session_hours: DEMO_SESSION_HOURS,
  });
}
