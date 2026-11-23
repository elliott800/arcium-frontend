// GET ?q=  public repos plus the viewer's own.   POST { name, description }  a new private repo.

import { type NextRequest } from 'next/server';
import { handle, hubParam, json, preflight, requireViewer, viewerOf } from '@/lib/hub-http';
import { createRepo, listRepos } from '@/lib/hubs';

type Ctx = { params: Promise<{ hub: string }> };
export const OPTIONS = preflight;

export async function GET(req: NextRequest, { params }: Ctx) {
  return handle(req, async () => {
    const hub = hubParam((await params).hub);
    return json(req, { repos: await listRepos(hub, await viewerOf(req), req.nextUrl.searchParams.get('q') ?? '') });
  });
}

export async function POST(req: NextRequest, { params }: Ctx) {
  return handle(req, async () => {
    const hub = hubParam((await params).hub);
    const v = await requireViewer(req);
    const body = await req.json().catch(() => ({}));
    const { id: _id, ...repo } = await createRepo(hub, v.username, String(body.name ?? ''), String(body.description ?? ''));
    return json(req, { repo }, 201);
  });
}
