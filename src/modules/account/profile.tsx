'use client';

// Dashboard "Your account" (account.profile): the sign-in name and phone, the Arcium keys (passkeys) that sign
// this person in with one click (the Admin button on the sign-in page), and its Data Hub API keys and subscriptions
// (DataHubAccess). One Arcium account works on every Arcium site.
//
//   API   GET /api/sso/me · POST /api/sso/profile · the passkey routes through src/app/_public/passkey.ts

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { deviceName, passkeyList, passkeyRemove, passkeySave, passkeysSupported } from '@/app/_public/passkey';
import { Notice, Page, postJson, useJson } from '@/ui/kit';
import DataHubAccess from './DataHubAccess';

interface Me { username: string; display_name?: string; email: string; phone: string | null; role: string }
type Key = Awaited<ReturnType<typeof passkeyList>>[number];
type Msg = { ok: boolean; text: string } | null;

const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'never';

export default function AccountProfile() {
  const { data: me, reload } = useJson<Me>('/api/sso/me');
  return (
    <Page title="Your account" intro={me ? <>Signed in as <strong>{me.display_name || me.username}</strong>.</> : 'Loading…'}>
      {me && (
        <div className="m-grid m-grid-wide">
          <Details me={me} onSaved={reload} />
          <Keys admin={me.role === 'admin'} />
          <DataHubAccess />
        </div>
      )}
    </Page>
  );
}

// ── your details: sign-in name and phone ──
function Details({ me, onSaved }: { me: Me; onSaved: () => void }) {
  const [name, setName] = useState(me.display_name && me.display_name !== me.username ? me.display_name : '');
  const [tel, setTel] = useState(me.phone ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const { ok, data } = await postJson('/api/sso/profile', { login_name: name, phone: tel });
    setBusy(false);
    if (!ok) { setMsg({ ok: false, text: data.error ?? 'Could not save.' }); return; }
    setTel(data.phone ?? '');
    setMsg({ ok: true, text: 'Saved.' });
    onSaved();
  }

  return (
    <section className="m-card">
      <h2>Your details</h2>
      <p className="m-muted">Sign in with your sign-in name, your username <strong>{me.username}</strong> or your email.</p>
      <form className="m-form" onSubmit={save}>
        <label>Sign-in name
          <input className="m-input" type="text" autoComplete="nickname" autoCapitalize="none" spellCheck={false}
            placeholder={me.username} value={name} onChange={e => setName(e.target.value)} />
        </label>
        <label>Phone number
          <input className="m-input" type="tel" autoComplete="tel" placeholder="+1 555 123 4567" value={tel} onChange={e => setTel(e.target.value)} />
        </label>
        <div className="m-row">
          <button type="submit" className="m-btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save details'}</button>
          <Notice msg={msg} />
        </div>
      </form>
    </section>
  );
}

// ── Arcium keys: save one on this device, see and remove the others ──
function Keys({ admin }: { admin: boolean }) {
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(() => { passkeyList().then(setKeys); }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the browser's support is only known after mount
    setSupported(passkeysSupported());
    load();
  }, [load]);

  async function save() {
    setBusy(true); setMsg(null);
    const { ok, data } = await passkeySave(deviceName());
    setBusy(false);
    if (!ok) { setMsg({ ok: false, text: data.error ?? 'Could not save the key.' }); return; }
    setMsg({ ok: true, text: data.approved || !admin ? 'Saved. Next time, press Admin on the sign-in page.'
      : 'Saved. It opens your admin account once an admin approves it.' });
    load();
  }

  async function remove(k: Key) {
    if (!window.confirm(`Remove the key "${k.name}"? That device will need your password again.`)) return;
    if (await passkeyRemove(k.id)) load();
  }

  return (
    <section className="m-card">
      <h2>Arcium keys</h2>
      <p className="m-muted">Save a key in this device&apos;s password manager (Windows Hello, iPhone, Chrome, 1Password).
        Then the <strong>Admin</strong> button on the sign-in page signs you in with one click, on every Arcium site.</p>
      <div className="m-row">
        {supported
          ? <button type="button" className="m-btn primary" onClick={save} disabled={busy}>{busy ? 'Waiting for your device…' : 'Save a key on this device'}</button>
          : <span className="m-muted">This browser can&apos;t hold keys. Try Chrome, Edge or Safari.</span>}
        <Notice msg={msg} />
      </div>
      {keys && keys.length > 0 && (
        <ul className="m-list">
          {keys.map(k => (
            <li key={k.id}>
              <span>{k.name}<small className="m-muted"> · saved {day(k.created_at)} · last used {day(k.last_used_at)}
                {admin && !k.admin_approved ? ' · waiting for admin approval' : ''}</small></span>
              <button type="button" className="m-btn danger" onClick={() => remove(k)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
