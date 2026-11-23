'use client';

// Credentials (owner): the broker and data keys the site holds for machines, stored encrypted. Only their names
// show; a machine fetches one with its machine key (GET /api/machine/credentials/<id>, a hook).
import { Page, Table, ago, useJson } from '@/ui/kit';

interface Credential { id: string; owner: string; kind: string; label: string; machine_name: string | null; updated_at: string; used_by_accounts: number }

export default function ControlCredentials() {
  const { data, error } = useJson<Credential[]>('/api/admin/credentials', 60000);
  return (
    <Page title="Credentials" intro="Broker and data keys, stored encrypted; only their names show here.">
      {error && <p className="m-error">{error}</p>}
      <Table rows={data ?? []} rowKey={c => c.id} empty={data ? 'No credentials stored.' : 'Loading…'} columns={[
        { key: 'label', label: 'Label', render: c => <strong>{c.label}</strong> },
        { key: 'kind', label: 'Kind' },
        { key: 'owner', label: 'Owner' },
        { key: 'machine_name', label: 'Machine' },
        { key: 'used_by_accounts', label: 'Accounts', numeric: true },
        { key: 'updated_at', label: 'Updated', render: c => ago(c.updated_at) },
      ]} />
    </Page>
  );
}
