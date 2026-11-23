// GET  the repo and the versions this viewer may see.
// PATCH { description?, visibility?, code_visible? }  owner: settings (public sends the newest version to review).
// DELETE  owner: delete the repo and every version.

import { type NextRequest } from 'next/server';
import { handle, json, preflight, repoParam, viewerOf } from '@/lib/hub-http';
import { canManage, canSeeRepo, canSeeVersion, deleteRepo, listVersions, updateRepo } from '@/lib/hubs';

type Ctx = { params: Promise<{ hub: string; owner: string; name: string }> };
export const OPTIONS = preflight;

export async function GET(req: NextRequest, { params }: Ctx) {
  return handle(req, async () => {
    const { hub, owner, name } = await params;
    const v = await viewerOf(req);
    const repo = await repoParam(hub, owner, name, r => canSeeRepo(r, v));
    const versions = (await listVersions(repo)).filter(x => canSeeVersion(repo, x, v));
    const { id: _id, ...shown } = repo;
    return json(req, { repo: shown, versions, manage: canManage(repo, v) });
  });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  return handle(req, async () => {
    const { hub, owner, name } = await params;
    const v = await viewerOf(req);
    const repo = await repoParam(hub, owner, name, r => canManage(r, v));
    const { id: _id, ...shown } = await updateRepo(repo, await req.json().catch(() => ({})));
    return json(req, { repo: shown });
  });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  return handle(req, async () => {
    const { hub, owner, name } = await params;
    const v = await viewerOf(req);
    await deleteRepo(await repoParam(hub, owner, name, r => canManage(r, v)));
    return json(req, { ok: true });
  });
}
