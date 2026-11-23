// API (admin): one recorded file of a branch review (a screenshot, a video or a report), from REVIEWS_DIR only.
//   GET ?p=<repo>/pr-<n>/<sha>/after/factory.silos.png

import { type NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { reviewFile } from '@/lib/reviews';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const f = reviewFile(req.nextUrl.searchParams.get('p') ?? '');
  if (!f) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  return new NextResponse(new Uint8Array(f.body), { headers: { 'Content-Type': f.type, 'Cache-Control': 'private, max-age=3600' } });
}
