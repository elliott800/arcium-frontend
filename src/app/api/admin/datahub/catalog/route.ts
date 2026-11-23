// The Data Hub catalog for the Data Hub page (admin).
//   GET ?view=streams&q=&cls=stock|commodity|currency|realestate|bond|crypto|economic|other&deriv=spot|futures|swaps|options
//       &must=tag,tag&not=tag,tag&limit=   -> { total, counts: { cls, deriv }, tags: [[tag, n]], streams: [...] }
//   GET ?view=sources                       -> { sources: [{ connection, type, enabled, error, keys: [{ key, hooks, on, failing, rows, last_run, every }] }] }

import { type NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { catalogSources, catalogStreams } from '@/lib/datahubCatalog';
import { matchesTags } from '@/lib/instruments';

const list = (v: string | null) => (v ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const sp = req.nextUrl.searchParams;
  try {
    if (sp.get('view') === 'sources') return NextResponse.json({ sources: await catalogSources() }, { headers: { 'Cache-Control': 'no-store' } });
    const all = await catalogStreams();
    if (sp.get('view') === 'tree') {
      // asset class -> instrument type -> source -> symbol (with its fresh / stale counts and the jobs it has)
      type Sym = { symbol: string; count: number; fresh: number; stale: number; keys: string[] };
      const tree: Record<string, { cls: string; count: number; derivs: Record<string, { deriv: string; count: number; sources: Record<string, { source: string; count: number; symbols: Record<string, Sym> }> }> }> = {};
      for (const s of all) {
        const c = (tree[s.asset_class] ??= { cls: s.asset_class, count: 0, derivs: {} });
        c.count++;
        const d = (c.derivs[s.derivative] ??= { deriv: s.derivative, count: 0, sources: {} });
        d.count++;
        const src = (d.sources[s.source] ??= { source: s.source, count: 0, symbols: {} });
        src.count++;
        const name = s.symbol || '(no symbol)';
        const sym = (src.symbols[name] ??= { symbol: name, count: 0, fresh: 0, stale: 0, keys: [] });
        sym.count++;
        if (s.fresh) sym.fresh++; else sym.stale++;
        if (!sym.keys.includes(s.key)) sym.keys.push(s.key);
      }
      const out = Object.values(tree).sort((a, b) => b.count - a.count).map(c => ({
        ...c, derivs: Object.values(c.derivs).sort((a, b) => b.count - a.count).map(d => ({
          ...d, sources: Object.values(d.sources).sort((a, b) => b.count - a.count).map(src => ({
            ...src, symbols: Object.values(src.symbols).sort((a, b) => b.count - a.count).slice(0, 3000) })) })) }));
      return NextResponse.json({ tree: out, total: all.length }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const source = (sp.get('source') ?? '').trim();
    const key = (sp.get('key') ?? '').trim();
    const q = (sp.get('q') ?? '').trim().toUpperCase();
    const cls = sp.get('cls') ?? '';
    const deriv = sp.get('deriv') ?? '';
    const f = { must: list(sp.get('must')), not: list(sp.get('not')) };
    const base = all.filter(s => (!q || s.symbol.includes(q) || s.hook_id.toUpperCase().includes(q)) && matchesTags(s, f));
    // counts for the chips: classes under the other filters, types under the chosen class
    const counts = { cls: {} as Record<string, number>, deriv: {} as Record<string, number> };
    for (const s of base) {
      if (!deriv || s.derivative === deriv) counts.cls[s.asset_class] = (counts.cls[s.asset_class] ?? 0) + 1;
      if (!cls || s.asset_class === cls) counts.deriv[s.derivative] = (counts.deriv[s.derivative] ?? 0) + 1;
    }
    const shown = base.filter(s => (!cls || s.asset_class === cls) && (!deriv || s.derivative === deriv)
      && (!source || s.source === source) && (!key || s.key === key));
    const tagCount = new Map<string, number>();
    for (const s of shown) for (const t of s.tags) if (!t.includes(':')) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    const limit = Math.min(1000, Math.max(1, Number(sp.get('limit')) || 300));
    const streams = [...shown].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.source.localeCompare(b.source) || a.key.localeCompare(b.key)).slice(0, limit);
    return NextResponse.json({ total: shown.length, counts, tags: [...tagCount].sort((a, b) => b[1] - a[1]).slice(0, 60), streams },
      { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json({ error: `The Data Hub tables can't be read here (${(e as Error).message.slice(0, 120)}).` }, { status: 503 });
  }
}
