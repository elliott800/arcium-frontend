// The Data Hub page's calls to its API (/api/admin/datahub/*).

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: 'no-store', ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error || `Request failed (${r.status})`);
  return d as T;
}

export const hub = (q: Record<string, string>) => `/api/admin/datahub/hub?${new URLSearchParams(q)}`;
export const post = <T,>(body: Record<string, unknown>) => api<T>('/api/admin/datahub/hub', { method: 'POST', body: JSON.stringify(body) });

export interface HubList { name: string; kind: string; category: string | null; tags: string[]; record: boolean; members: string[]; sublists: string[] }
export const lists = () => api<{ lists: HubList[]; running: boolean; note?: string }>('/api/admin/datahub/lists');
export const listCommand = (body: Record<string, unknown>) => api<{ ok: boolean }>('/api/admin/datahub/lists', { method: 'POST', body: JSON.stringify(body) });

export interface HubCommand { id: number; status: string; result: Record<string, unknown> | null }
/** Waits for a queued hub command to finish (done or failed); the source manager claims commands within seconds. */
export async function waitFor(id: number, timeoutMs = 120000): Promise<HubCommand> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const c = await api<HubCommand>(hub({ view: 'command', id: String(id) }));
    if (c.status === 'done' || c.status === 'failed' || Date.now() > end) return c;
    await new Promise(r => setTimeout(r, 1500));
  }
}
