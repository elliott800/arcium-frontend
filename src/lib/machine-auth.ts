// Machine authentication: the backend controller machines sign their /api/machine/* calls with a name and key.

import { type NextRequest } from 'next/server';
import { verifyMachine } from '@/lib/db';

/** Machine credentials from headers (preferred — keeps keys out of URLs and
 *  server logs) or, for older clients, query params. Returns the machine
 *  name when the key is valid, else null. */
export async function authenticateMachine(req: NextRequest): Promise<string | null> {
  const name = req.headers.get('x-machine-name') ?? req.nextUrl.searchParams.get('machine_name') ?? '';
  const key = req.headers.get('x-machine-key') ?? req.nextUrl.searchParams.get('api_key') ?? '';
  return (await verifyMachine(name, key)) ? name : null;
}
