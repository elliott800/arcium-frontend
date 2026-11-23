// Pure logic for watchlists (no database, no framework imports, so node --test can load it directly and the
// Portfolio Maker can run it in the browser):
//   - saved tag filters: must-have and can't-have tag lists, cleaned and matched
//   - list members: a list holds symbols, other lists (a collection) and sources (fred:UNRATE, catalog:yahoo.etfs),
//     all in one shape { type, value }
//   - collections: flatten a list of lists into one universe, skipping cycles and missing lists

// ── saved tag filters ────────────────────────────────────────────────────────

export interface TagFilterLists { must: string[]; not: string[] }
export interface SavedFilter extends TagFilterLists { name: string }

const TAG_RE = /^[a-z0-9_.:\-]{1,40}$/;
const FILTER_NAME_RE = /^[\w .\-&()/+]{1,60}$/;
export const MAX_FILTER_TAGS = 30;

export function validFilterName(name: unknown): name is string {
  return typeof name === 'string' && name.trim().length > 0 && FILTER_NAME_RE.test(name.trim());
}

const tagList = (v: unknown): string[] => {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,;]+/) : [];
  const out: string[] = [];
  for (const t of raw) {
    const s = String(t ?? '').trim().toLowerCase();
    if (s && TAG_RE.test(s) && !out.includes(s)) out.push(s);
  }
  return out;
};

/** A tag filter from any input: tags trimmed, lower case, unique, valid. A tag in both lists stays only in `not`
 *  (a can't-have always wins). Null when there are too many tags. An empty filter is allowed (it matches all). */
export function normalizeFilter(input: unknown): TagFilterLists | null {
  const o = (input && typeof input === 'object' ? input : {}) as { must?: unknown; not?: unknown };
  const not = tagList(o.not);
  const must = tagList(o.must).filter(t => !not.includes(t));
  if (must.length + not.length > MAX_FILTER_TAGS) return null;
  return { must, not };
}

/** A row passes when it carries every must-have tag and none of the can't-have tags. */
export function matchesFilter(row: { tags?: string[] }, f: TagFilterLists): boolean {
  const tags = new Set((row.tags ?? []).map(t => t.toLowerCase()));
  return f.must.every(t => tags.has(t)) && !f.not.some(t => tags.has(t));
}

/** The saved filters with one added or replaced (by name, case-insensitive), sorted by name. */
export function upsertFilter(filters: SavedFilter[], f: SavedFilter): SavedFilter[] {
  const key = f.name.trim().toLowerCase();
  return [...filters.filter(x => x.name.trim().toLowerCase() !== key), { ...f, name: f.name.trim() }]
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A saved filter by name (case-insensitive), or null. */
export function findFilter(filters: SavedFilter[], name: string): SavedFilter | null {
  const key = name.trim().toLowerCase();
  return filters.find(f => f.name.trim().toLowerCase() === key) ?? null;
}

// ── list members ─────────────────────────────────────────────────────────────

export type MemberType = 'symbol' | 'list' | 'source';
export interface Member { type: MemberType; value: string }

const LIST_NAME_RE = /^[\w .:\-&()/+#]{1,80}$/;
const SOURCE_KIND_RE = /^[a-z][a-z0-9_]{0,23}$/;
const SOURCE_ID_RE = /^[A-Za-z0-9][\w.\-^=/@]{0,79}$/;
const MEMBER_SYMBOL_RE = /^@?[A-Z0-9][A-Z0-9._\-^=]{0,39}$/;

/** A source reference in its standard spelling: kind:id with the kind in lower case (fred:UNRATE,
 *  catalog:yahoo.etfs). FRED series ids are upper case. Empty string if it can't be a source. */
export function normalizeSource(raw: string): string {
  const s = raw.trim().replace(/^source:/i, '');
  const i = s.indexOf(':');
  if (i <= 0) return '';
  const kind = s.slice(0, i).toLowerCase();
  let id = s.slice(i + 1).trim();
  if (!SOURCE_KIND_RE.test(kind) || !SOURCE_ID_RE.test(id)) return '';
  if (kind === 'fred') id = id.toUpperCase();
  return `${kind}:${id}`;
}

/** One member from its written form: 'list:Name' (another list; 'list:hub:Name' for a Data Hub list), 'source:kind:id'
 *  or plain 'kind:id' (a source), else a symbol (upper case). Null if it is none of these. */
export function parseMember(raw: string): Member | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower.startsWith('list:')) {
    const name = s.slice(5).trim();
    return LIST_NAME_RE.test(name) ? { type: 'list', value: name } : null;
  }
  if (s.includes(':')) {
    const src = normalizeSource(s);
    return src ? { type: 'source', value: src } : null;
  }
  const sym = s.toUpperCase();
  return MEMBER_SYMBOL_RE.test(sym) ? { type: 'symbol', value: sym } : null;
}

/** The written form of a member, the inverse of parseMember. */
export function memberString(m: Member): string {
  return m.type === 'list' ? `list:${m.value}` : m.type === 'source' ? `source:${m.value}` : m.value;
}

/** Members split by type, each unique in the order given; with the pieces that were none of them. */
export function splitMembers(raw: string[]): { symbols: string[]; sublists: string[]; sources: string[]; rejected: string[] } {
  const out = { symbols: [] as string[], sublists: [] as string[], sources: [] as string[], rejected: [] as string[] };
  for (const r of raw) {
    const m = parseMember(r);
    if (!m) { if (String(r ?? '').trim()) out.rejected.push(String(r)); continue; }
    const bucket = m.type === 'symbol' ? out.symbols : m.type === 'list' ? out.sublists : out.sources;
    if (!bucket.includes(m.value)) bucket.push(m.value);
  }
  return out;
}

// ── collections ──────────────────────────────────────────────────────────────

/** A list as the flattener sees it: its symbols, sources and the keys of the lists it holds. */
export interface ListNode { symbols: string[]; sources?: string[]; sublists?: string[] }

/** The key of a sublist named inside a list of the given scope: a person's list names its own lists by name and a
 *  Data Hub list as 'hub:Name'; a Data Hub list names other hub lists by name. */
export function sublistKey(scope: 'mine' | 'hub', ref: string): string {
  if (/^hub:/i.test(ref)) return `hub:${ref.slice(4)}`;
  if (/^mine:/i.test(ref) && scope === 'mine') return `mine:${ref.slice(5)}`;
  return `${scope}:${ref}`;
}

export interface Universe {
  symbols: string[];            // every symbol in the collection and the lists under it, each once, first seen first
  sources: string[];
  lists: string[];              // the lists opened, root first
  missing: string[];            // sublists that don't exist (or can't be seen)
  cycles: string[];             // 'a -> b' links skipped because b was already open above a
}

/** A collection opened as one universe: depth first, each list read once, a link back to a list already open
 *  above it skipped (and reported), missing lists reported. `childKey` turns a list's sublist entry into a key. */
export function flattenCollection(root: string, get: (key: string) => ListNode | undefined,
  childKey: (parent: string, ref: string) => string = (_p, ref) => ref, maxDepth = 32): Universe {
  const u: Universe = { symbols: [], sources: [], lists: [], missing: [], cycles: [] };
  const seenSym = new Set<string>();
  const seenSrc = new Set<string>();
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (key: string, depth: number) => {
    const node = get(key);
    if (!node) { if (!u.missing.includes(key)) u.missing.push(key); return; }
    done.add(key); u.lists.push(key); path.push(key);
    for (const s of node.symbols) { const k = s.toUpperCase(); if (!seenSym.has(k)) { seenSym.add(k); u.symbols.push(s); } }
    for (const s of node.sources ?? []) if (!seenSrc.has(s)) { seenSrc.add(s); u.sources.push(s); }
    for (const ref of node.sublists ?? []) {
      const child = childKey(key, ref);
      if (path.includes(child)) { u.cycles.push(`${key} -> ${child}`); continue; }
      if (done.has(child)) continue;              // a diamond: its members are in already
      if (depth + 1 > maxDepth) { u.cycles.push(`${key} -> ${child}`); continue; }
      visit(child, depth + 1);
    }
    path.pop();
  };
  visit(root, 0);
  return u;
}

/** Whether adding `child` under `parent` would make a cycle (child already holds parent, at any depth). */
export function wouldCycle(parent: string, child: string, get: (key: string) => ListNode | undefined,
  childKey: (parent: string, ref: string) => string = (_p, ref) => ref): boolean {
  if (parent === child) return true;
  return flattenCollection(child, get, childKey).lists.includes(parent);
}
