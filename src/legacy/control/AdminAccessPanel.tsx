'use client';

// Legacy panel (Control panel > Users): sign-ups waiting for approval, invitations, machine keys.

import { useEffect, useState } from 'react';

interface PendingRow { user_id: string; username: string; email: string; created_at: string; email_verified_at: string | null }
interface InviteRow { email: string; role: string; created_at: string; expires_at: string; used_at: string | null; open: boolean }
interface MachineRow {
  machine_name: string; hostname: string | null; last_heartbeat: string | null; registered: boolean; registered_by: string | null;
  capacity: number; accepts_accounts: boolean; account_count: number;
  load_json: { accounts?: number; stacks_running?: number; cpu_percent?: number | null } | null;
}

/** Admin: approve sign-ups, invite users and register machines. Invite links
 *  and machine keys are shown exactly once — the site only keeps their hashes. */
export default function AdminAccessPanel() {
  const [pending, setPending] = useState<PendingRow[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [machines, setMachines] = useState<MachineRow[]>([]);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'user' | 'admin'>('user');
  const [machineName, setMachineName] = useState('');
  const [secretShown, setSecretShown] = useState<{ label: string; value: string } | null>(null);
  const [error, setError] = useState('');

  async function load() {
    const [pend, inv, mach] = await Promise.all([
      fetch('/api/admin/approvals', { cache: 'no-store' }).then(r => (r.ok ? r.json() : [])).catch(() => []),
      fetch('/api/admin/invites', { cache: 'no-store' }).then(r => (r.ok ? r.json() : [])).catch(() => []),
      fetch('/api/admin/machines', { cache: 'no-store' }).then(r => (r.ok ? r.json() : [])).catch(() => []),
    ]);
    setPending(pend);
    setInvites(inv);
    setMachines(mach);
  }

  useEffect(() => { load(); }, []);

  async function post(url: string, body: unknown) {
    setError('');
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setError(data.error ?? 'Request failed.'); return null; }
    await load();
    return data;
  }

  async function invite() {
    const data = await post('/api/admin/invites', { email, role: inviteRole });
    if (data) {
      setSecretShown({ label: `Invite link for ${data.email} (valid ${data.expires_in_days} days)`, value: data.invite_url });
      setEmail('');
    }
  }

  async function decide(p: PendingRow, action: 'approve' | 'reject') {
    if (action === 'reject' && !confirm(`Reject the sign-up from ${p.username}?`)) return;
    await post('/api/admin/approvals', { user_id: p.user_id, action });
  }

  async function registerMachine(name: string) {
    if (!confirm(`Issue a new key for "${name}"? Any key it already has stops working.`)) return;
    const data = await post('/api/admin/machines', { machine_name: name });
    if (data) {
      setSecretShown({ label: `API key for ${data.machine_name} — put it in controller/machine.settings → web_sync.api_key`, value: data.api_key });
      setMachineName('');
    }
  }

  async function setCapacity(m: MachineRow, capacity: number, accepts: boolean) {
    setError('');
    const res = await fetch('/api/admin/machines', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machine_name: m.machine_name, capacity, accepts_accounts: accepts }),
    });
    if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? 'Update failed.');
    await load();
  }

  const loadText = (l: MachineRow['load_json']) =>
    l ? `${l.stacks_running ?? 0} stacks${l.cpu_percent != null ? ` · cpu ${l.cpu_percent}%` : ''}` : '—';

  const fmt = (s: string | null) => (s ? new Date(s).toLocaleString() : '—');

  return (
    <>
      <div className="p-admin-section">
        <div className="p-action-group-label">Sign-ups waiting for approval</div>
        {pending.length === 0 ? (
          <p style={{ fontSize: 11, opacity: 0.7, margin: '4px 0 0' }}>None waiting.</p>
        ) : (
          <table className="p-admin-table" style={{ marginTop: 8, fontSize: 11 }}>
            <thead><tr><th>Username</th><th>Email</th><th>Email confirmed</th><th>Signed up</th><th></th></tr></thead>
            <tbody>
              {pending.map(p => (
                <tr key={p.user_id}>
                  <td>{p.username}</td><td>{p.email}</td>
                  <td>{p.email_verified_at ? fmt(p.email_verified_at) : 'not yet'}</td>
                  <td>{fmt(p.created_at)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="p-dash-btn p-dash-btn--accent" onClick={() => decide(p, 'approve')}
                            disabled={!p.email_verified_at} title={p.email_verified_at ? '' : 'Waiting for them to confirm their email'}>
                      Approve
                    </button>{' '}
                    <button className="p-dash-btn" onClick={() => decide(p, 'reject')}>Reject</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="p-admin-section">
        <div className="p-action-group-label">Invite a user</div>
        <div className="p-admin-machine-row" style={{ gridTemplateColumns: 'minmax(180px, 260px) auto auto' }}>
          <input className="p-field-input" type="email" placeholder="name@example.com" aria-label="Invitee email"
                 value={email} onChange={e => setEmail(e.target.value)} />
          <select className="p-catalog-select" aria-label="Role" value={inviteRole}
                  onChange={e => setInviteRole(e.target.value as 'user' | 'admin')}>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
          <button className="p-dash-btn p-dash-btn--accent" onClick={invite} disabled={!email}>Create invite</button>
        </div>
        {invites.length > 0 && (
          <table className="p-admin-table" style={{ marginTop: 8, fontSize: 11 }}>
            <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Expires</th></tr></thead>
            <tbody>
              {invites.map(i => (
                <tr key={`${i.email}-${i.created_at}`}>
                  <td>{i.email}</td><td>{i.role}</td>
                  <td>{i.used_at ? `accepted ${fmt(i.used_at)}` : i.open ? 'pending' : 'expired'}</td>
                  <td>{fmt(i.expires_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="p-admin-section">
        <div className="p-action-group-label">Machine keys</div>
        <div className="p-admin-machine-row">
          <input className="p-field-input" placeholder="new machine name" aria-label="New machine name"
                 value={machineName} onChange={e => setMachineName(e.target.value)} />
          <button className="p-dash-btn p-dash-btn--accent" onClick={() => registerMachine(machineName.trim())}
                  disabled={!machineName.trim()}>Register machine</button>
        </div>
        <table className="p-admin-table" style={{ marginTop: 8, fontSize: 11 }}>
          <thead><tr><th>Machine</th><th>Host</th><th>Last heartbeat</th><th>Key</th><th>Accounts</th><th>Capacity</th><th>Takes accounts</th><th>Load</th><th></th></tr></thead>
          <tbody>
            {machines.map(m => (
              <tr key={m.machine_name}>
                <td>{m.machine_name}</td><td>{m.hostname ?? '—'}</td><td>{fmt(m.last_heartbeat)}</td>
                <td>{m.registered ? 'registered' : 'none'}</td>
                <td>{m.account_count}</td>
                <td><input className="p-field-input" type="number" min={0} max={500} style={{ width: 56 }}
                           aria-label={`Capacity for ${m.machine_name}`} defaultValue={m.capacity}
                           onBlur={e => { const v = Number(e.target.value); if (v !== m.capacity) setCapacity(m, v, m.accepts_accounts); }} /></td>
                <td><input type="checkbox" checked={m.accepts_accounts} aria-label={`${m.machine_name} takes accounts`}
                           onChange={e => setCapacity(m, m.capacity, e.target.checked)} /></td>
                <td>{loadText(m.load_json)}</td>
                <td><button className="p-dash-btn" onClick={() => registerMachine(m.machine_name)}>
                  {m.registered ? 'Rotate key' : 'Issue key'}
                </button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error && <p role="alert" style={{ fontSize: 11, color: '#f43f5e' }}>{error}</p>}

      {secretShown && (
        <div className="p-modal-backdrop">
          <div className="p-modal" onClick={e => e.stopPropagation()}>
            <div className="p-modal-header">
              <h2 className="p-modal-title">Copy this now</h2>
            </div>
            <div className="p-modal-body">
              <p style={{ fontSize: 12, marginTop: 0 }}>{secretShown.label}. It won&apos;t be shown again.</p>
              <input className="p-field-input" readOnly value={secretShown.value} style={{ width: '100%' }}
                     onFocus={e => e.currentTarget.select()} aria-label="Secret value" />
            </div>
            <div className="p-modal-footer">
              <button className="p-dash-btn" onClick={() => navigator.clipboard?.writeText(secretShown.value)}>Copy</button>
              <button className="p-dash-btn p-dash-btn--accent" onClick={() => setSecretShown(null)}>Done</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
