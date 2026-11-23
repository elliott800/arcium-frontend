import 'server-only';
// The Portfolio Maker's server side, shared by the Arcium Factory (portal engines), the Fusion Hub and the
// Data Hub: search every instrument the site knows, read a pasted list into symbols, and edit a portfolio
// without touching the rest of its row (category, rate, tags).
//
// Every asset has one standard symbol, and a tag set: its class tags (stock, etf, currency, ...) and a source
// reference for each source that has it, written source:symbol in that source's own spelling (oanda:EUR_USD,
// yahoo:EURUSD=X, webull:AAPL). Standard symbols: upper case; FX and metals as BASE_QUOTE (EUR/USD, EURUSD and
// Yahoo's EURUSD=X all read as EUR_USD); crypto as COIN_QUOTE (BTC-USD reads as BTC_USD); Arcium's own
// instruments (spreads, rolls made in house) start with '@' (e.g. @GLD_SLV) and are always accepted.

import { getDb, stripEmail } from '@/lib/db';
import { recordedInstruments } from '@/lib/workbench';
import { classify, mainClassOf, type MainClass } from '@/lib/instruments';
import { normalizeFilter, type Member, type SavedFilter } from '@/lib/watchlist-logic';

const CCY = new Set(['USD', 'EUR', 'JPY', 'GBP', 'CHF', 'AUD', 'CAD', 'NZD', 'CNH', 'CNY', 'HKD', 'SGD', 'SEK', 'NOK', 'DKK',
  'PLN', 'CZK', 'HUF', 'TRY', 'ZAR', 'MXN', 'THB', 'INR', 'XAU', 'XAG', 'XPT', 'XPD']);
const COINS = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'LTC', 'BCH', 'DOT', 'AVAX', 'LINK', 'MATIC']);
const COIN_QUOTES = new Set(['USD', 'USDT', 'USDC', 'EUR']);
export const ARCIUM_PREFIX = '@';
const SYMBOL_RE = /^@?[A-Z0-9][A-Z0-9._\-^=]{0,39}$/;

/** The standard symbol for any source's spelling. Empty string if it can't be a symbol. */
export function normalizeSymbol(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return '';
  if (s.startsWith(ARCIUM_PREFIX)) return SYMBOL_RE.test(s) ? s : '';
  const fx = s.match(/^([A-Z]{3})[/\-_]?([A-Z]{3})(=X)?$/);
  if (fx && CCY.has(fx[1]) && CCY.has(fx[2])) return `${fx[1]}_${fx[2]}`;
  const coin = s.match(/^([A-Z]{2,5})[/\-_]?(USDT|USDC|USD|EUR)$/);
  if (coin && COINS.has(coin[1]) && COIN_QUOTES.has(coin[2])) return `${coin[1]}_${coin[2]}`;
  return SYMBOL_RE.test(s) ? s : '';
}

/** Spellings a source may use for a standard symbol (to find it in the Data Hub's hooks). */
function spellings(symbol: string): string[] {
  const out = new Set([symbol]);
  const m = symbol.match(/^([A-Z]{2,5})_([A-Z]{3,4})$/);
  if (m) {
    const [, a, b] = m;
    for (const v of [`${a}${b}`, `${a}/${b}`, `${a}-${b}`]) out.add(v);
    if (CCY.has(a) && CCY.has(b)) out.add(`${a}${b}=X`);
  }
  return [...out];
}

/** A pasted list (commas, semicolons, spaces, tabs or new lines) as unique standard symbols in the order given,
 *  and the pieces that could not be symbols. */
export function parseBatch(text: string): { symbols: string[]; rejected: string[] } {
  const symbols: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const piece of text.split(/[\s,;|]+/)) {
    if (!piece) continue;
    const s = normalizeSymbol(piece);
    if (!s) { rejected.push(piece); continue; }
    if (!seen.has(s)) { seen.add(s); symbols.push(s); }
  }
  return { symbols, rejected };
}

export interface InstrumentHit {
  symbol: string;               // the standard symbol
  tags: string[];               // class tags, then source references source:symbol
  sources: string[];            // where the site knows it from: Data Hub connections, 'list: <name>'
  rates: string[];              // bar rates the Data Hub records for it
  bars: number;
  asset_class: MainClass;       // stock, commodity, currency, realestate, bond, crypto or other
}

/** Collects hits by standard symbol, merging every source's spelling into one asset. */
class Assets {
  private map = new Map<string, InstrumentHit>();

  add(raw: string, source: string, opts: { rates?: string[]; bars?: number; reference?: boolean } = {}) {
    const s = normalizeSymbol(raw);
    if (!s) return;
    const known = this.map.get(s);
    const h = known ?? { symbol: s, tags: [...classify(source, s).tags], sources: [], rates: [], bars: 0, asset_class: mainClassOf(s, source) };
    if (!h.sources.includes(source)) h.sources.push(source);
    if (opts.reference) {
      const ref = `${source}:${raw.trim().toUpperCase()}`;
      if (!h.tags.includes(ref)) h.tags.push(ref);
    }
    for (const r of opts.rates ?? []) if (r && !h.rates.includes(r)) h.rates.push(r);
    h.bars += opts.bars ?? 0;
    this.map.set(s, h);
  }

  get(symbol: string) { return this.map.get(symbol); }
  all() { return [...this.map.values()].map(h => ({ ...h, rates: [...h.rates].sort() })); }
}

/** Instruments matching q, from the Data Hub's recorded candles (each source's spelling), the Data Hub's lists and
 *  the Data Hub's lists (funds, collections). Exact matches first, then by symbol. */
export async function searchInstruments(q: string, limit = 50): Promise<InstrumentHit[]> {
  const term = normalizeSymbol(q) || q.trim().toUpperCase().replace(/[%_\\]/g, '');
  const assets = new Assets();
  const terms = [...new Set([term, term.replace(/[_/\-]/g, '')])].filter(Boolean);
  for (const t of terms) {
    for (const r of await recordedInstruments(t, 400)) assets.add(r.symbol, r.source, { rates: r.rates, bars: r.bars, reference: true });
  }
  const likes = terms.map(t => `%${t.replace(/[%\\]/g, '')}%`);
  try {
    const rows = await getDb().prepare(
      `SELECT DISTINCT upper(member) AS s, list_name FROM wh_list_members WHERE upper(member) LIKE ANY(?::text[]) LIMIT 400`).all(likes) as { s: string; list_name: string }[];
    for (const r of rows) assets.add(r.s, `list: ${r.list_name}`);
  } catch {}
  const t = term.toUpperCase();
  return assets.all()
    .sort((a, b) => Number(b.symbol === t) - Number(a.symbol === t) || Number(b.symbol.startsWith(t)) - Number(a.symbol.startsWith(t))
      || a.symbol.localeCompare(b.symbol))
    .slice(0, Math.max(1, Math.min(limit, 200)));
}

/** Which of these standard symbols the site knows (found, with their tags) and which it doesn't. '@' symbols
 *  are Arcium's own and count as found. */
export async function resolveSymbols(symbols: string[]): Promise<{ found: InstrumentHit[]; unknown: string[] }> {
  const found: InstrumentHit[] = [];
  const unknown: string[] = [];
  const assets = new Assets();
  if (symbols.length) {
    const raw = [...new Set(symbols.flatMap(s => spellings(s.toUpperCase())))];
    const rows = await getDb().prepare(`
      SELECT upper(COALESCE(h.params->>'instrument', h.params->>'ticker')) AS symbol, h.connection_name AS source,
             array_agg(DISTINCT h.params->>'data_rate') AS rates
      FROM wh_hooks h JOIN wh_series s ON s.hook_id = h.hook_id AND s.store = 'ohlcv' AND s.n_rows > 0
      WHERE h.key LIKE '%candles' AND upper(COALESCE(h.params->>'instrument', h.params->>'ticker')) = ANY(?::text[])
      GROUP BY 1, 2`).all(raw) as { symbol: string; source: string; rates: string[] }[];
    for (const r of rows) assets.add(r.symbol, r.source, { rates: r.rates || [], reference: true });
    for (const [table, col, label] of [['wh_list_members', 'member', 'lists']] as const) {
      try {
        const extra = await getDb().prepare(`SELECT DISTINCT upper(${col}) AS s FROM ${table} WHERE upper(${col}) = ANY(?::text[])`)
          .all(raw) as { s: string }[];
        for (const r of extra) assets.add(r.s, label);
      } catch {}
    }
  }
  for (const s of symbols) {
    const h = assets.get(normalizeSymbol(s));
    if (h) found.push({ ...h, rates: [...h.rates].sort() });
    else if (s.startsWith(ARCIUM_PREFIX)) found.push({ symbol: s, tags: ['arcium'], sources: ['arcium'], rates: [], bars: 0, asset_class: 'other' });
    else unknown.push(s);
  }
  return { found, unknown };
}

// ── editing ──────────────────────────────────────────────────────────────────

// A list's symbols stay in watchlists.instrument_names (every other reader of that column sees symbols only); its
// other members, other lists (a collection) and sources (fred:UNRATE, catalog:yahoo.etfs), sit in user_list_members,
// the person's equivalent of the Data Hub's wh_list_members.
export interface Watchlist {
  watchlist_name: string; instruments: string[]; catalog_source: string | null; data_rate: string | null; tags: string | null; created_at: string;
  sublists: string[];           // lists it holds, by name ('hub:Name' for a Data Hub list)
  sources: string[];            // sources it holds, kind:id
}

const NAME_RE = /^[\w .\-&()/+]{1,60}$/;
export function validName(name: unknown): name is string {
  return typeof name === 'string' && NAME_RE.test(name.trim()) && name.trim().length > 0;
}

function toList(row: { instrument_names: string } & Record<string, unknown>): Watchlist {
  return {
    watchlist_name: String(row.watchlist_name),
    instruments: String(row.instrument_names || '').split(',').map(s => s.trim()).filter(Boolean),
    catalog_source: (row.catalog_source as string) ?? null, data_rate: (row.data_rate as string) ?? null,
    tags: (row.tags as string) ?? null, created_at: String(row.created_at ?? ''), sublists: [], sources: [],
  };
}

let membersReady: Promise<unknown> | null = null;
function membersTable(): Promise<unknown> {
  membersReady ??= getDb().prepare(`CREATE TABLE IF NOT EXISTS user_list_members (
      username text NOT NULL, list_name text NOT NULL, member_type text NOT NULL CHECK (member_type IN ('list', 'source')),
      member text NOT NULL, added_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (username, list_name, member_type, member))`).run().catch(e => { membersReady = null; throw e; });
  return membersReady;
}

/** Each of the person's lists' non-symbol members, by list name. */
async function membersByList(username: string): Promise<Map<string, { sublists: string[]; sources: string[] }>> {
  const out = new Map<string, { sublists: string[]; sources: string[] }>();
  try {
    await membersTable();
    const rows = await getDb().prepare(`SELECT list_name, member_type, member FROM user_list_members WHERE username IN (?, ?)
      ORDER BY added_at, member`).all(username, stripEmail(username)) as { list_name: string; member_type: string; member: string }[];
    for (const r of rows) {
      const m = out.get(r.list_name) ?? { sublists: [], sources: [] };
      const bucket = r.member_type === 'list' ? m.sublists : m.sources;
      if (!bucket.includes(r.member)) bucket.push(r.member);
      out.set(r.list_name, m);
    }
  } catch {}
  return out;
}

async function withMembers(username: string, lists: Watchlist[]): Promise<Watchlist[]> {
  const members = await membersByList(username);
  return lists.map(l => ({ ...l, ...(members.get(l.watchlist_name) ?? { sublists: [], sources: [] }) }));
}

export async function listWatchlists(username: string): Promise<Watchlist[]> {
  const rows = await getDb().prepare(`SELECT * FROM watchlists WHERE username IN (?, ?) ORDER BY lower(watchlist_name)`)
    .all(username, stripEmail(username)) as ({ instrument_names: string } & Record<string, unknown>)[];
  return withMembers(username, rows.map(toList));
}

/** Add and/or remove symbols in one watchlist, creating it when asked. Of the row, only instrument_names changes;
 *  order is kept and new symbols go at the end. Other members (lists, sources) are added and removed in
 *  user_list_members. Returns the list after the change, or null if it doesn't exist. */
export async function editWatchlist(username: string, name: string, add: string[], remove: string[], create = false,
  addMembers: Member[] = [], removeMembers: Member[] = []): Promise<Watchlist | null> {
  const db = getDb();
  const owners = [username, stripEmail(username)];
  const row = await db.prepare(`SELECT * FROM watchlists WHERE username IN (?, ?) AND watchlist_name = ?`)
    .get(...owners, name) as ({ instrument_names: string; username: string } & Record<string, unknown>) | undefined;
  if (!row && !create) return null;
  const current = row ? toList(row).instruments : [];
  const drop = new Set(remove.map(s => s.toUpperCase()));
  const next = current.filter(s => !drop.has(s.toUpperCase()));
  const have = new Set(next.map(s => s.toUpperCase()));
  for (const s of add) if (!have.has(s.toUpperCase())) { next.push(s); have.add(s.toUpperCase()); }
  if (row) {
    await db.prepare(`UPDATE watchlists SET instrument_names = ? WHERE username = ? AND watchlist_name = ?`)
      .run(next.join(','), row.username, name);
  } else {
    await db.prepare(`INSERT INTO watchlists (username, watchlist_name, instrument_names, created_at) VALUES (?, ?, ?, ?)`)
      .run(username, name, next.join(','), new Date().toISOString());
  }
  const others = (ms: Member[]) => ms.filter(m => m.type !== 'symbol');
  if (others(addMembers).length || others(removeMembers).length) {
    await membersTable();
    for (const m of others(removeMembers)) {
      await db.prepare(`DELETE FROM user_list_members WHERE username IN (?, ?) AND list_name = ? AND member_type = ? AND member = ?`)
        .run(...owners, name, m.type, m.value);
    }
    for (const m of others(addMembers)) {
      await db.prepare(`INSERT INTO user_list_members (username, list_name, member_type, member) VALUES (?, ?, ?, ?)
        ON CONFLICT DO NOTHING`).run(stripEmail(username), name, m.type, m.value);
    }
  }
  const after = await db.prepare(`SELECT * FROM watchlists WHERE username IN (?, ?) AND watchlist_name = ?`)
    .get(...owners, name) as ({ instrument_names: string } & Record<string, unknown>);
  const [list] = await withMembers(username, [toList(after)]);
  return list;
}

export async function renameWatchlist(username: string, from: string, to: string): Promise<'ok' | 'missing' | 'exists'> {
  const db = getDb();
  const owners = [username, stripEmail(username)];
  const exists = await db.prepare(`SELECT 1 FROM watchlists WHERE username IN (?, ?) AND watchlist_name = ?`).get(...owners, to);
  if (exists) return 'exists';
  const r = await db.prepare(`UPDATE watchlists SET watchlist_name = ? WHERE username IN (?, ?) AND watchlist_name = ?`)
    .run(to, ...owners, from) as { changes?: number };
  if (!r?.changes) return 'missing';
  try {                         // its members move with it, and collections that hold it follow the new name
    await membersTable();
    await db.prepare(`UPDATE user_list_members SET list_name = ? WHERE username IN (?, ?) AND list_name = ?`).run(to, ...owners, from);
    await db.prepare(`DELETE FROM user_list_members WHERE username IN (?, ?) AND member_type = 'list' AND member = ?
      AND list_name IN (SELECT list_name FROM user_list_members WHERE username IN (?, ?) AND member_type = 'list' AND member = ?)`)
      .run(...owners, from, ...owners, to);
    await db.prepare(`UPDATE user_list_members SET member = ? WHERE username IN (?, ?) AND member_type = 'list' AND member = ?`).run(to, ...owners, from);
  } catch {}
  return 'ok';
}

export async function deleteWatchlist(username: string, name: string): Promise<boolean> {
  const r = await getDb().prepare(`DELETE FROM watchlists WHERE username IN (?, ?) AND watchlist_name = ?`)
    .run(username, stripEmail(username), name) as { changes?: number };
  if (r?.changes) {
    try {                       // its own members, and its place in any collection
      await membersTable();
      await getDb().prepare(`DELETE FROM user_list_members WHERE username IN (?, ?) AND (list_name = ? OR (member_type = 'list' AND member = ?))`)
        .run(username, stripEmail(username), name, name);
    } catch {}
  }
  return !!r?.changes;
}

// -- saved tag filters (must-have and can't-have tags, by name, per person) --

let filtersReady: Promise<unknown> | null = null;
function filtersTable(): Promise<unknown> {
  filtersReady ??= getDb().prepare(`CREATE TABLE IF NOT EXISTS watchlist_filters (
      username text NOT NULL, name text NOT NULL, must text NOT NULL DEFAULT '[]', not_tags text NOT NULL DEFAULT '[]',
      updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (username, name))`).run().catch(e => { filtersReady = null; throw e; });
  return filtersReady;
}

const parseTags = (v: unknown): string[] => { try { const a = JSON.parse(String(v ?? '[]')); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
const toFilter = (r: { name: string; must: string; not_tags: string }): SavedFilter =>
  ({ name: r.name, ...(normalizeFilter({ must: parseTags(r.must), not: parseTags(r.not_tags) }) ?? { must: [], not: [] }) });

export async function listFilters(username: string): Promise<SavedFilter[]> {
  await filtersTable();
  const rows = await getDb().prepare(`SELECT name, must, not_tags FROM watchlist_filters WHERE username = ? ORDER BY lower(name)`)
    .all(stripEmail(username)) as { name: string; must: string; not_tags: string }[];
  return rows.map(toFilter);
}

export async function getFilter(username: string, name: string): Promise<SavedFilter | null> {
  await filtersTable();
  const row = await getDb().prepare(`SELECT name, must, not_tags FROM watchlist_filters WHERE username = ? AND lower(name) = lower(?)`)
    .get(stripEmail(username), name.trim()) as { name: string; must: string; not_tags: string } | undefined;
  return row ? toFilter(row) : null;
}

/** Save a filter under its name, replacing one of the same name (any case). */
export async function saveFilter(username: string, f: SavedFilter): Promise<SavedFilter> {
  await filtersTable();
  const db = getDb();
  const user = stripEmail(username);
  await db.prepare(`DELETE FROM watchlist_filters WHERE username = ? AND lower(name) = lower(?)`).run(user, f.name.trim());
  await db.prepare(`INSERT INTO watchlist_filters (username, name, must, not_tags) VALUES (?, ?, ?, ?)`)
    .run(user, f.name.trim(), JSON.stringify(f.must), JSON.stringify(f.not));
  return { name: f.name.trim(), must: f.must, not: f.not };
}

export async function deleteFilter(username: string, name: string): Promise<boolean> {
  await filtersTable();
  const r = await getDb().prepare(`DELETE FROM watchlist_filters WHERE username = ? AND lower(name) = lower(?)`)
    .run(stripEmail(username), name.trim()) as { changes?: number };
  return !!r?.changes;
}
