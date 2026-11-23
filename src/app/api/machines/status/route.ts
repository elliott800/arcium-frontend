// API: what the controller machines last reported (Factory > Machine, Engine Hangar).

import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { isDemo } from '@/lib/site-mode';
import { DEMO_MACHINE, touchDemoMachine } from '@/lib/demo';

export const dynamic = 'force-dynamic';

// GET -> { machines: [{ machine_name, hostname, platform, last_heartbeat, live_status, live_status_at }], can_control }
// What the controller machines last reported, for the Factory's Machine and Engine Hangar dashboards. Signed-in
// users read it; only the owner on the live site may send commands (can_control; /api/admin/machines/control).
// The demo's simulated machine has no launcher, so its status is built from the visitor's own silos and curves.
export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const db = getDb();
  if (isDemo) {
    await touchDemoMachine();
    const silos = await db.prepare(`SELECT silo_name FROM silo_registry WHERE username = ? ORDER BY silo_name`)
      .all(user.username) as { silo_name: string }[];
    const curves = await db.prepare(`
      SELECT DISTINCT ON (silo_name, engine_kind) silo_name, engine_kind, cycle_time, equity, balance,
             count(*) OVER (PARTITION BY silo_name, engine_kind) AS n
      FROM web_equity_curve WHERE username = ? ORDER BY silo_name, engine_kind, cycle_time DESC`).all(user.username) as
      { silo_name: string; engine_kind: string; cycle_time: string; equity: number | null; balance: number | null; n: number }[];
    const engines: Record<string, Record<string, unknown>> = {};
    for (const c of curves) {
      const kind = c.engine_kind === 'simulated' ? 'sim' : c.engine_kind;
      (engines[c.silo_name] ??= {})[kind] = {
        pid: null, state: 'simulated', cycle: Number(c.n), max_cycles: null, started: null,
        updated: new Date(c.cycle_time).getTime(), balance: c.balance, equity: c.equity, error: null, exit_code: null,
      };
    }
    const now = new Date().toISOString();
    return NextResponse.json({
      can_control: false, demo: true,
      machines: [{ machine_name: DEMO_MACHINE, hostname: 'simulated', platform: 'demo', last_heartbeat: now, live_status_at: now,
        live_status: { commit: 'demo', paused: false, processes: 0, up_seconds: 3600, heartbeat_pid: 1,
          silos: silos.map(s => s.silo_name), training: {}, engines } }],
    });
  }
  const machines = await db.prepare(`
    SELECT machine_name, hostname, platform, last_heartbeat, live_status, live_status_at
    FROM machines ORDER BY machine_name`).all();
  return NextResponse.json({ can_control: user.role === 'admin', demo: false, machines });
}
