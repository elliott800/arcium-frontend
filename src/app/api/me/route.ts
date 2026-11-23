// API: who is signed in (username, display name, role).

import { type NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { displayName } from '@/lib/profile';

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  // username stays the key pages call the API with; display_name is only what the page shows
  return NextResponse.json({ ...user, display_name: await displayName(user.user_id, user.username) });
}
