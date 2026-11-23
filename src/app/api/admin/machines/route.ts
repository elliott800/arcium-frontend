// API (admin): the controller machines, their keys and capacity (Control panel > Users > Machine keys).

import { type NextRequest, NextResponse } from 'next/server';
import { getMachines, registerMachine, setMachineCapacity } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json(await getMachines());
}

// body: { machine_name } -> { api_key } — shown once; registering an existing
// machine issues a new key and invalidates the old one.
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const { machine_name } = await req.json().catch(() => ({}));
  const name = String(machine_name ?? '').trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
    return NextResponse.json({ error: 'machine_name must be 1-64 chars of letters, digits, _ . -' }, { status: 400 });
  }
  const apiKey = await registerMachine(name, admin.email);
  return NextResponse.json({
    ok: true, machine_name: name, api_key: apiKey,
    note: 'Put this key in the machine\'s controller/machine.settings web_sync.api_key. It will not be shown again.',
  });
}

// body: { machine_name, capacity, accepts_accounts } — how many accounts the
// load balancer may place on this machine.
export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const { machine_name, capacity, accepts_accounts } = await req.json().catch(() => ({}));
  const cap = Number(capacity);
  if (!Number.isInteger(cap) || cap < 0 || cap > 500) {
    return NextResponse.json({ error: 'capacity must be an integer 0-500' }, { status: 400 });
  }
  const ok = await setMachineCapacity(String(machine_name ?? ''), cap, accepts_accounts !== false);
  if (!ok) return NextResponse.json({ error: 'machine not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
