// GET: who is signed in, for the hub pages ({ user: null } when nobody is).

import { type NextRequest } from 'next/server';
import { handle, json, preflight, viewerOf } from '@/lib/hub-http';

export const OPTIONS = preflight;
export async function GET(req: NextRequest) {
  return handle(req, async () => json(req, { user: await viewerOf(req) }));
}
