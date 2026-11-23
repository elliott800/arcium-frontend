// GET            the version's files (with which ones this viewer may read) and the review checks.
// GET ?path=...  one file's text (null when binary), if the viewer may read it.

import { type NextRequest } from 'next/server';
import { handle, json, preflight, repoParam, viewerOf } from '@/lib/hub-http';
import { HubError, canManage, canReadFile, canSeeRepo, canSeeVersion, fileText, listVersions, versionChecks, versionFiles } from '@/lib/hubs';

type Ctx = { params: Promise<{ hub: string; owner: string; name: string; number: string }> };
export const OPTIONS = preflight;

export async function GET(req: NextRequest, { params }: Ctx) {
  return handle(req, async () => {
    const { hub, owner, name, number } = await params;
    const v = await viewerOf(req);
    const repo = await repoParam(hub, owner, name, r => canSeeRepo(r, v));
    const n = Number(number);
    const version = (await listVersions(repo)).find(x => x.number === n);
    if (!version || !canSeeVersion(repo, version, v)) throw new HubError('No such version.', 404);
    const path = req.nextUrl.searchParams.get('path');
    if (path != null) {
      if (!canReadFile(repo, path, v)) throw new HubError("This repo's code is not public.", 403);
      const file = await fileText(repo, n, path);
      if (!file) throw new HubError('No such file.', 404);
      return json(req, { path, ...file });
    }
    const files = (await versionFiles(repo, n)).map(f => ({ path: f.path, size: f.size, readable: canReadFile(repo, f.path, v) }));
    return json(req, { version, files, checks: canManage(repo, v) ? versionChecks(repo.hub, await versionFiles(repo, n)) : [] });
  });
}
