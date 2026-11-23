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
