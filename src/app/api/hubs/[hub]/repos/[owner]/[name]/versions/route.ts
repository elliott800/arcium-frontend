// POST multipart: message, and files (each file's name is its path in the repo; a folder
// upload sends paths like "pkg/source_api.py"). Owner only. Makes the next version.

import { type NextRequest } from 'next/server';
import { handle, json, preflight, repoParam, requireViewer } from '@/lib/hub-http';
import { HubError, addVersion, canManage } from '@/lib/hubs';

type Ctx = { params: Promise<{ hub: string; owner: string; name: string }> };
export const OPTIONS = preflight;

export async function POST(req: NextRequest, { params }: Ctx) {
  return handle(req, async () => {
    const { hub, owner, name } = await params;
    const v = await requireViewer(req);
    const repo = await repoParam(hub, owner, name, r => canManage(r, v));
    const form = await req.formData().catch(() => { throw new HubError('Send the files as a form upload.'); });
    const uploads: { path: string; data: Buffer }[] = [];
    for (const f of form.getAll('files')) {
      if (typeof f === 'string') continue;
      uploads.push({ path: f.name, data: Buffer.from(await f.arrayBuffer()) });
    }
    const number = await addVersion(repo, v.username, String(form.get('message') ?? ''), uploads);
    return json(req, { number, review: repo.visibility === 'public' ? 'pending' : 'none' }, 201);
  });
}
