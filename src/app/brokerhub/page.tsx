// Page: the BrokerHub (brokerhub.arciumsignals.com, also /brokerhub on the app), owner only.

import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, userFromToken } from '@/lib/auth';
import BrokerHub from '@/modules/brokerhub/BrokerHub';
import '@/shell/shell.css';
import '@/modules/datahub/view/datahub.css';
import '@/modules/datahub/view/datahub-layout.css';

export const metadata: Metadata = { title: 'BrokerHub' };
export const dynamic = 'force-dynamic';

// brokerhub.arciumsignals.com serves this page at its root (src/proxy.ts rewrites it here).
export default async function BrokerHubPage() {
  const user = await userFromToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect('/?next=%2Fbrokerhub');
  if (user.role !== 'admin') redirect('/w');
  return <BrokerHub />;
}
