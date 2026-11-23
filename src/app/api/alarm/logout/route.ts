// POST with the device token -> signs that phone out (deletes its alarm_devices row).

import { type NextRequest, NextResponse } from 'next/server';
import { bearer, revokeDevice } from '@/lib/alarm';

export async function POST(req: NextRequest) {
  await revokeDevice(bearer(req));
  return NextResponse.json({ ok: true });
}
