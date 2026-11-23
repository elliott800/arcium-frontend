// Page: the Data Hub on its own (datahub.arciumsignals.com), owner only.

import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, userFromToken } from '@/lib/auth';
import DataHubModule from '@/modules/datahub/hub';
import '@/shell/shell.css';

export const metadata: Metadata = { title: 'Data Hub' };
export const dynamic = 'force-dynamic';

// datahub.arciumsignals.com serves this page at its root (src/proxy.ts rewrites it here): the Data Hub on
// its own, for the owner. In the app it is the Data Hub dashboard of the workspace (/w/datahub.hub).
export default async function DataHubPage() {
  const user = await userFromToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect('/?next=%2Fdatahub');
  if (user.role !== 'admin') redirect('/w');
  return <DataHubModule />;
}
