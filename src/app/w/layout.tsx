// Layout: the workspace shell around every /w page (signed-in only; menu built from the registry).

import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, accountFromToken, userFromToken } from '@/lib/auth';
import { getUserPreferences } from '@/lib/db';
import { displayName } from '@/lib/profile';
import { MODULES, mayOpen, moduleInfo } from '@/modules/registry';
import Shell from '@/shell/Shell';
import '@/shell/shell.css';

export const metadata: Metadata = { title: 'Workspace' };

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const user = await userFromToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) {
    // signed in but not granted the portal's functions: the user dashboard
    if (await accountFromToken((await cookies()).get(SESSION_COOKIE)?.value)) redirect('/home');
    redirect('/?next=/w');
  }
  const me = { username: user.username, role: user.role, portal: true };
  const prefs = await getUserPreferences(user.username).catch(() => ({} as Record<string, unknown>));
  const modules = MODULES.filter(m => mayOpen(m, me)).map(moduleInfo);
  return (
    <Shell me={{ ...me, display_name: await displayName(user.user_id, user.username) }} modules={modules} initial={prefs.workspace}>
      {children}
    </Shell>
  );
}
