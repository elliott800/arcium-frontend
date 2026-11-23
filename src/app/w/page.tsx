// The workspace with nothing open: every dashboard this person may open, by group, one click away.

import { cookies } from 'next/headers';
import { SESSION_COOKIE, userFromToken } from '@/lib/auth';
import { GROUPS, MODULES, mayOpen } from '@/modules/registry';

export default async function WorkspaceHome() {
  const user = await userFromToken((await cookies()).get(SESSION_COOKIE)?.value);
  const mine = MODULES.filter(m => user && mayOpen(m, { role: user.role, portal: true }));
  return (
    <div className="m-page">
      <div className="m-head"><h1>Workspace</h1><p>Open a dashboard from the panel, or pick one here.</p></div>
      {GROUPS.map(g => {
        const ms = mine.filter(m => m.group === g);
        return ms.length ? (
          <section key={g} className="m-card">
            <h2>{g}</h2>
            <div className="m-grid">
              {ms.map(m => (
                <a key={m.id} href={`/w/${m.id}`} className="ws-home-item">
                  <strong>{m.title}</strong>{m.status === 'planned' && <span className="m-badge"> planned</span>}
                  <div className="m-muted">{m.summary}</div>
                </a>
              ))}
            </div>
          </section>
        ) : null;
      })}
    </div>
  );
}
