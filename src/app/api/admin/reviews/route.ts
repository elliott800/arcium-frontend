// API (admin): Branch reviews. GET lists the pull requests the review sync downloaded (with the demo agent's report),
// the walkthroughs and the live preview's state. POST records the owner's decision on GitHub, or asks for a preview.
//
//   GET                                                   -> { configured, prs[], walkthroughs[], preview }
//   POST { action: 'decide', repo, pr, event: 'APPROVE' | 'REQUEST_CHANGES', body }   -> { ok } (posts a GitHub review)
//   POST { action: 'preview', repo, pr }                  -> { ok } (the server builds and starts it; one at a time)
// The files (screenshots, videos) come from ./file. Everything is in src/lib/reviews.ts.

import { type NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { REVIEWS_DIR, decide, listReviews, requestPreview } from '@/lib/reviews';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json({ configured: Boolean(REVIEWS_DIR), token: Boolean(process.env.GITHUB_REVIEW_TOKEN), ...listReviews() });
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const b = (await req.json().catch(() => ({}))) as { action?: string; repo?: string; pr?: number; event?: string; body?: string };
  const repo = String(b.repo ?? '');
  const pr = Number(b.pr);
  if (!/^[\w.-]+$/.test(repo) || !Number.isInteger(pr) || pr <= 0) {
    return NextResponse.json({ error: 'repo and pr required' }, { status: 400 });
  }
  if (b.action === 'decide') {
    if (b.event !== 'APPROVE' && b.event !== 'REQUEST_CHANGES') return NextResponse.json({ error: 'event must be APPROVE or REQUEST_CHANGES' }, { status: 400 });
    const r = await decide(repo, pr, b.event, String(b.body ?? ''), admin.username);
    return NextResponse.json(r, { status: r.ok ? 200 : 400 });
  }
  if (b.action === 'preview') {
    const r = requestPreview(repo, pr, admin.username);
    return NextResponse.json(r, { status: r.ok ? 200 : 400 });
  }
  return NextResponse.json({ error: 'action must be decide or preview' }, { status: 400 });
}
