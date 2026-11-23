'use client';

// The Portfolio Maker (watchlist maker): pick or create a list, add symbols (search, paste, or a fund's
// holdings), filter by tags, and apply the list to a silo. Applying queues `apply_watchlist` on the silo's
// machine, which stores it as the silo's watchlist setting in the backend's database. The owner can switch
// the panel to the Data Hub's own lists (bundles and trackers live there too).
import { useState } from 'react';
import WatchlistPanel from '@/legacy/factory/WatchlistPanel';
import '@/legacy/compat.css';
import '@/legacy/factory/portfolio.css';
import { Notice, Page, postJson, useJson } from '@/ui/kit';
import type { SiloRegistryRow } from '@/lib/api-types';

export default function PortfoliosModule() {
  const { data: silos } = useJson<SiloRegistryRow[]>('/api/silos');
  const { data: me } = useJson<{ username: string }>('/api/me');
  const [pick, setPick] = useState('');
  const [kind, setKind] = useState<'sim' | 'live'>('sim');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const silo = (silos ?? []).find(s => s.silo_key === pick) ?? silos?.[0] ?? null;

  const apply = async (name: string, symbols: string[]) => {
    if (!silo || !me) { setMsg({ ok: false, text: 'No silo to apply it to.' }); return; }
    const { ok, data } = await postJson('/api/scripts/dispatch', {
      machine_name: silo.machine_name || 'arcium_machine', username: me.username, command: 'apply_watchlist',
      flags: { watchlist_name: name, silo_name: silo.silo_name, person: silo.person_name, engine_kind: kind,
               username: me.username, instruments: symbols.join(',') },
    });
    setMsg(ok ? { ok: true, text: `${name} (${symbols.length}) sent to ${silo.silo_name}; its machine stores it in the silo's settings.` }
              : { ok: false, text: data.error || 'Could not apply the list.' });
  };

  return (
    <Page title="Portfolio Maker" intro="Watchlists for silos and the Data Hub."
      actions={<>
        <label className="m-row">Apply to
          <select className="m-input" aria-label="Silo" value={silo?.silo_key ?? ''} onChange={e => setPick(e.target.value)}>
            {(silos ?? []).map(s => <option key={s.silo_key} value={s.silo_key}>{s.silo_name}</option>)}
          </select>
        </label>
        <select className="m-input" aria-label="Engine" value={kind} onChange={e => setKind(e.target.value as 'sim' | 'live')}>
          <option value="sim">simulated engine</option><option value="live">practice-live engine</option>
        </select>
      </>}>
      <Notice msg={msg} />
      <div className="m-card">
        <WatchlistPanel allowHub wide onApply={apply} />
      </div>
    </Page>
  );
}
