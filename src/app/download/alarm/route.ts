// The ArciumAlarm Android app, for admins. A page route rather than /api/ so a plain link
// works: signed out, it sends the browser to sign in and back here. The APK sits in
// downloads/ (not public/, and not in git: it's ~55 MB); copy a new build over it to update.
// turbopackIgnore: read at request time only; keeps the bundler from tracing the 55 MB file.

import { type NextRequest, NextResponse } from 'next/server';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { getSessionUser } from '@/lib/auth';

const APK = path.join(/* turbopackIgnore: true */ process.cwd(), 'downloads', 'ArciumAlarm.apk');

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  // Relative, so it stays on the address that was typed (a LAN IP, localhost or the domain).
  if (!user) return new NextResponse(null, { status: 307, headers: { Location: '/?next=%2Fdownload%2Falarm' } });
  if (user.role !== 'admin') return new NextResponse('Admin only.', { status: 403 });

  const info = await stat(APK).catch(() => null);
  if (!info) return new NextResponse('The ArciumAlarm APK is not on this server.', { status: 404 });

  const body = Readable.toWeb(createReadStream(APK)) as ReadableStream;
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': String(info.size),
      'Content-Disposition': 'attachment; filename="ArciumAlarm.apk"',
    },
  });
}
