// The schedule as a fillable PDF, for admins. A page route so a plain link works (signed out, it
// goes to sign-in and back). Built by scripts/schedule_pdf.py from src/lib/schedule-release1.json.

import { type NextRequest, NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getSessionUser } from '@/lib/auth';
import { privatePath } from '@/lib/private-content';

const PDF = privatePath('Arcium_10_Week_Schedule.pdf',
  path.join(/* turbopackIgnore: true */ process.cwd(), 'downloads', 'Arcium_10_Week_Schedule.pdf'));

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return new NextResponse(null, { status: 307, headers: { Location: '/?next=%2Fcontrol%2Fschedule%2Fpdf' } });
  if (user.role !== 'admin') return new NextResponse('Admin only.', { status: 403 });

  const body = await readFile(PDF).catch(() => null);
  if (!body) return new NextResponse('The schedule PDF is not on this server: run python scripts/schedule_pdf.py.', { status: 404 });
  return new NextResponse(new Uint8Array(body), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(body.length),
      'Content-Disposition': 'attachment; filename="Arcium_10_Week_Schedule.pdf"',
      'Cache-Control': 'no-store',
    },
  });
}
