// The site's standard drill tree: the data behind every rainbow drill table (src/ui/drill/DrillTable.tsx).
// Pure (no React, no server imports), so pages, API routes and tests can all build and query trees the same way.
//
//   const tree = DrillTree.fromRows(rows, r => [r.assetClass, r.form], r => ({ id: r.id, label: r.symbol, tags: [r.source] }));
//   tree.filter('# stock !# future "Apple Inc."').size     // items matching a tag query
//   tree.selectionState(node, selectedIds)                 // 'none' | 'some' | 'all'

/** One row of a drill tree. Leaves are the selectable items; branches group them. */
export interface DrillNode<D = unknown> {
  id: string;                    // unique across the tree (selection and expansion are kept by id)
  label: string;
  tags?: string[];               // searched by tag queries (with every ancestor's tags)
  count?: number;                // items beneath; computed from the children when left out
  children?: DrillNode<D>[];
  lazy?: boolean | string;       // children are loaded on expand (DrillTable's loadChildren)
  data?: D;                      // anything the page needs per row
}

// ---- tag queries: "# stock option !# future # technology "Apple Inc."" ------------------------------------------------

export interface TagQuery { include: string[]; exclude: string[]; phrases: string[] }

/** Repeated `#` (include) and `!#` (exclude) groups; tags separated by spaces or commas; quoted text is an exact
 *  phrase. Words before any operator are plain text terms. */
export function parseTagQuery(text: string): TagQuery {
  const out: TagQuery = { include: [], exclude: [], phrases: [] };
  let mode: 'text' | 'include' | 'exclude' = 'text';
  for (const tok of text.match(/!#|#|"(?:\\.|[^"\\])*"|[^\s,]+/g) ?? []) {
    if (tok === '#') { mode = 'include'; continue; }
    if (tok === '!#') { mode = 'exclude'; continue; }
    if (tok.startsWith('"')) { const p = tok.slice(1, -1).trim().toLowerCase(); if (p) out.phrases.push(p); continue; }
    const t = tok.replace(/^[!#]+/, '').trim().toLowerCase();
    if (!t) continue;
    if (mode === 'include') out.include.push(t); else if (mode === 'exclude') out.exclude.push(t); else out.phrases.push(t);
  }
  return out;
}

export const isEmptyQuery = (q: TagQuery) => !q.include.length && !q.exclude.length && !q.phrases.length;

/** Every included tag matches, no excluded tag matches, every phrase appears in the text. */
export function matchesQuery(q: TagQuery, tags: string[], text: string): boolean {
  const ts = tags.map(t => t.toLowerCase());
  const lower = text.toLowerCase();
  const has = (t: string) => ts.includes(t) || ts.some(x => x.split(/[\s/:]+/).includes(t));
  return q.include.every(has) && !q.exclude.some(has) && q.phrases.every(p => lower.includes(p));
}

// ---- the tree ---------------------------------------------------------------------------------------------------------

export type SelectionState = 'none' | 'some' | 'all';

export class DrillTree<D = unknown> {
  readonly nodes: DrillNode<D>[];

  constructor(nodes: DrillNode<D>[]) { this.nodes = nodes; }

  /** Items beneath a node (its count, else its leaves; 1 for a leaf). */
  static countOf<D>(n: DrillNode<D>): number {
    if (typeof n.count === 'number') return n.count;
    return n.children?.length ? n.children.reduce((s, c) => s + DrillTree.countOf(c), 0) : 1;
  }

  /** Ids of every leaf beneath a node (the node itself when it is a leaf). */
  static leafIds<D>(n: DrillNode<D>): string[] {
    return n.children?.length ? n.children.flatMap(c => DrillTree.leafIds(c)) : [n.id];
  }

  /** Whether a node's leaves are selected: none, some (the mixed state) or all. */
  static selectionState<D>(n: DrillNode<D>, selected: ReadonlySet<string>): SelectionState {
    const ids = DrillTree.leafIds(n);
    const k = ids.filter(id => selected.has(id)).length;
    return k === 0 ? 'none' : k === ids.length ? 'all' : 'some';
  }

  /** Builds a tree from flat rows: `path` gives each row's branch labels (outermost first), `leaf` its item.
   *  Branches are sorted by size (largest first), then label; leaves by label. */
  static fromRows<R, D = unknown>(rows: R[], path: (r: R) => string[], leaf: (r: R) => DrillNode<D>, idPrefix = 'n'): DrillTree<D> {
    type B = { label: string; branches: Map<string, B>; leaves: DrillNode<D>[] };
    const root: B = { label: '', branches: new Map(), leaves: [] };
    for (const r of rows) {
      let b = root;
      for (const label of path(r)) {
        let next = b.branches.get(label);
        if (!next) { next = { label, branches: new Map(), leaves: [] }; b.branches.set(label, next); }
        b = next;
      }
      b.leaves.push(leaf(r));
    }
    const build = (b: B, id: string): DrillNode<D>[] => {
      const branches = [...b.branches.values()].map(c => {
        const cid = `${id}/${c.label}`;
        const children = build(c, cid);
        return { id: cid, label: c.label, tags: [c.label.toLowerCase()], children, count: children.reduce((s, x) => s + DrillTree.countOf(x), 0) };
      }).sort((x, y) => y.count - x.count || x.label.localeCompare(y.label));
      const leaves = [...b.leaves].sort((x, y) => x.label.localeCompare(y.label));
      return [...branches, ...leaves];
    };
    return new DrillTree(build(root, idPrefix));
  }

  /** Items in the tree. */
  get size(): number { return this.nodes.reduce((s, n) => s + DrillTree.countOf(n), 0); }

  /** Every leaf, depth first. */
  leaves(): DrillNode<D>[] {
    const out: DrillNode<D>[] = [];
    const walk = (ns: DrillNode<D>[]) => ns.forEach(n => (n.children?.length ? walk(n.children) : out.push(n)));
    walk(this.nodes);
    return out;
  }

  /** Every leaf id. */
  leafIds(): string[] { return this.leaves().map(n => n.id); }

  /** The node with this id, if any. */
  find(id: string): DrillNode<D> | undefined {
    const walk = (ns: DrillNode<D>[]): DrillNode<D> | undefined => {
      for (const n of ns) { if (n.id === id) return n; const f = n.children && walk(n.children); if (f) return f; }
      return undefined;
    };
    return walk(this.nodes);
  }

  /** The tree cut down to items matching a tag query (branches kept when something beneath matches; a lazy
   *  branch is kept when it matches itself). Counts are recomputed. */
  filter(query: string | TagQuery): DrillTree<D> {
    const q = typeof query === 'string' ? parseTagQuery(query) : query;
    if (isEmptyQuery(q)) return this;
    const walk = (ns: DrillNode<D>[], inherited: string[], text: string): DrillNode<D>[] => {
      const out: DrillNode<D>[] = [];
      for (const n of ns) {
        const tags = [...inherited, ...(n.tags ?? [])];
        const t = `${text} ${n.label}`;
        if (n.children?.length) {
          const kids = walk(n.children, tags, t);
          if (kids.length) out.push({ ...n, children: kids, count: kids.reduce((s, k) => s + DrillTree.countOf(k), 0) });
          else if (n.lazy && matchesQuery(q, tags, t)) out.push(n);
        } else if (matchesQuery(q, tags, t)) out.push(n);
      }
      return out;
    };
    return new DrillTree(walk(this.nodes, [], ''));
  }

  /** A new tree with each node replaced by fn(node) (children mapped first). */
  map<E>(fn: (n: DrillNode<D>) => DrillNode<E>): DrillTree<E> {
    const walk = (ns: DrillNode<D>[]): DrillNode<E>[] => ns.map(n => fn({ ...n, children: n.children ? walk(n.children) as unknown as DrillNode<D>[] : undefined }));
    return new DrillTree(walk(this.nodes));
  }
}
