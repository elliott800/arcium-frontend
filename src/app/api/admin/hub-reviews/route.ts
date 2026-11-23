// Admin: hub versions waiting for review (publishing a repo, or a new version of a public one).
// GET  the queue.   POST { hub, owner, name, number, approve, note }  approve or reject one.

import { type NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { isHubId } from '@/lib/hub-origins';
import { HubError, getRepo, pendingReviews, review } from '@/lib/hubs';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json({ pending: await pendingReviews() });
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const b = await req.json().catch(() => ({}));
  const repo = isHubId(String(b.hub)) ? await getRepo(b.hub, String(b.owner ?? ''), String(b.name ?? '')) : null;
  if (!repo) return NextResponse.json({ error: 'No such repo.' }, { status: 404 });
  try {
    await review(repo, Number(b.number), b.approve === true, String(b.note ?? ''), admin.username);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof HubError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
