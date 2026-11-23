'use client';

// The site's standard rainbow drill table. Give it a DrillTree (or nodes) and the columns to show after the name:
//
//   <DrillTable nodes={tree} nameTitle="Instrument" columns={[{ id: 'src', title: 'Source', cell: n => n.data?.source }]}
//     selectable selected={sel.selected} onSelect={sel.toggle} rainbow={rainbow} />
//
// Rows open to show their children; a checkbox at every level selects everything beneath it (a partly selected branch
// shows the mixed state); expanded rows stay open while you select or the data reloads (kept by node id); rainbow drill
// colours give each top-level branch its own hue, lighter by depth, with text colour picked for contrast; long branches
// show `pageSize` rows at a time. Lazy branches load their children on expand. See docs/views/03-drill-tables/.

import { Fragment, useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { DrillTree, type DrillNode } from '@/lib/drillTree';
import './drill-table.css';

export interface DrillCellInfo { depth: number; leaf: boolean; open: boolean }

// N is the page's node type: DrillNode, or an interface extending it with the page's own fields.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDrillNode = DrillNode<any>;

export interface DrillColumn<N extends AnyDrillNode = DrillNode> {
  id: string;
  title: ReactNode;
  cell: (n: N, info: DrillCellInfo) => ReactNode;
  className?: string;
  width?: number | string;
  align?: 'left' | 'right' | 'center';
}

export interface DrillTableProps<N extends AnyDrillNode = DrillNode> {
  nodes: N[] | DrillTree<N extends DrillNode<infer D> ? D : unknown>;
  nameTitle?: ReactNode;
  columns?: DrillColumn<N>[];
  /** Shown after a row's label (badges, pills). */
  nameExtra?: (n: N, info: DrillCellInfo) => ReactNode;
  rainbow?: boolean;
  /** 'auto' follows the system light/dark setting; 'light' or 'dark' fixes it. */
  theme?: 'auto' | 'light' | 'dark';
  selectable?: boolean;
  selected?: ReadonlySet<string>;
  onSelect?: (leafIds: string[], checked: boolean) => void;
  loadChildren?: (n: N) => Promise<N[]>;
  /** Rows shown when a leaf opens (for example its stored date intervals). Return null for a plain leaf. */
  expandLeaf?: (n: N) => N[] | null;
  /** Ids open at first. */
  defaultOpen?: string[];
  pageSize?: number;
  empty?: ReactNode;
  ariaLabel?: string;
  className?: string;
}

// ---- rainbow colours (the Arcium Datahub design) -----------------------------------------------------------------------

export const DRILL_HUES = [8, 205, 132, 278, 42, 185, 322, 92, 238, 58];
const lightnessAt = (d: number) => (d === 0 ? 32 : Math.min(93, 72 + (d - 1) * 9));
const saturationAt = (d: number) => (d === 0 ? 40 : Math.max(12, 26 - (d - 1) * 7));

/** Hue of a row: its top-level branch's hue, drifting toward yellow below depth 4. */
export function drillHue(parentHue: number | null, index: number, depth: number): number {
  const h = parentHue ?? DRILL_HUES[index % DRILL_HUES.length];
  const shift = Math.max(0, depth - 4) / 3;
  return (h + ((52 - h + 360) % 360) * shift) % 360;
}

/** The background of a cell (column 0 is the name; columns 1-3 get progressively lighter). */
export function drillCellColor(hue: number, depth: number, col: number) {
  const k = col >= 1 && col <= 3 ? col : 0;
  const s = Math.max(0, saturationAt(depth) - k * 3);
  const l = Math.min(93, lightnessAt(depth) + k * 2);
  return { s, l, css: `hsl(${hue} ${s}% ${l}%)` };
}

/** White or dark text for a background, whichever has more contrast (WCAG relative luminance). */
export function drillTextColor(hue: number, s: number, l: number): string {
  const L = l / 100, h = hue / 60;
  const c = (1 - Math.abs(2 * L - 1)) * s / 100;
  const x = c * (1 - Math.abs(h % 2 - 1));
  const m = L - c / 2;
  const rgb = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const lum = (ch: number[]) => 0.2126 * lin(ch[0]) + 0.7152 * lin(ch[1]) + 0.0722 * lin(ch[2]);
  const row = lum(rgb.map(v => v + m));
  const dark = lum([52 / 255, 64 / 255, 51 / 255]);
  return 1.05 / (row + 0.05) >= (row + 0.05) / (dark + 0.05) ? '#fff' : '#344033';
}

// ---- helpers ------------------------------------------------------------------------------------------------------------

/** Selection kept by leaf id: `toggle` is DrillTable's onSelect. */
export function useDrillSelection(initial: Iterable<string> = []) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initial));
  const toggle = useCallback((ids: string[], on: boolean) => setSelected(s => {
    const t = new Set(s);
    for (const id of ids) { if (on) t.add(id); else t.delete(id); }
    return t;
  }), []);
  const clear = useCallback(() => setSelected(new Set()), []);
  return { selected, setSelected, toggle, clear, size: selected.size };
}

/** The rainbow-colours setting, remembered per browser (on by default). */
export function useRainbowPreference(key = 'arc.drill.rainbow'): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(true);
  useEffect(() => { try { const v = localStorage.getItem(key); if (v !== null) setOn(v === '1'); } catch { /* storage unavailable */ } }, [key]);
  const set = useCallback((v: boolean) => { setOn(v); try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* ignore */ } }, [key]);
  return [on, set];
}

export function RainbowToggle({ checked, onChange, label = 'Rainbow drill colors' }: { checked: boolean; onChange: (on: boolean) => void; label?: string }) {
  return <label className="arc-drill-toggle"><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} /> {label}</label>;
}

/** A small rounded badge for a row (a source, a state). */
export function DrillPill({ children, tone }: { children: ReactNode; tone?: 'on' | 'off' | 'bad' | 'warn' }) {
  return <span className={`arc-drill-pill${tone ? ` is-${tone}` : ''}`}>{children}</span>;
}

// ---- the table ---------------------------------------------------------------------------------------------------------

export default function DrillTable<N extends AnyDrillNode = DrillNode>({
  nodes, nameTitle = 'Drill table', columns = [], nameExtra, rainbow = true, theme = 'auto', selectable, selected, onSelect,
  loadChildren, expandLeaf, defaultOpen, pageSize = 200, empty, ariaLabel, className,
}: DrillTableProps<N>) {
  const list = useMemo(() => (nodes instanceof DrillTree ? nodes.nodes as N[] : nodes), [nodes]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(defaultOpen ?? []));
  const [shown, setShown] = useState<Record<string, number>>({});
  const [lazy, setLazy] = useState<Record<string, N[] | 'loading' | string>>({});
  const sel = selected ?? new Set<string>();

  const toggleOpen = useCallback(async (n: N) => {
    setOpen(s => { const t = new Set(s); if (t.has(n.id)) t.delete(n.id); else t.add(n.id); return t; });
    if (n.lazy && loadChildren && !lazy[n.id]) {
      setLazy(l => ({ ...l, [n.id]: 'loading' }));
      try { const kids = await loadChildren(n); setLazy(l => ({ ...l, [n.id]: kids })); }
      catch (e) { setLazy(l => ({ ...l, [n.id]: (e as Error).message || 'Could not load.' })); }
    }
  }, [lazy, loadChildren]);

  const colCount = 1 + columns.length;

  // `owner`: the leaf these rows were opened from (expandLeaf). They are part of it, so their checkbox is the leaf's.
  function rows(ns: N[], depth: number, parentHue: number | null, path: string, owner?: N): ReactNode[] {
    const limit = shown[path] ?? pageSize;
    const out: ReactNode[] = [];
    ns.slice(0, limit).forEach((n, i) => {
      const hue = drillHue(parentHue, i, depth);
      const lazyKids = n.lazy ? lazy[n.id] : undefined;
      const extra = !owner && !n.children?.length && expandLeaf ? expandLeaf(n) : null;   // a leaf's rows do not open again
      const kids = (n.children?.length ? n.children : Array.isArray(lazyKids) ? lazyKids : extra) as N[] | null | undefined;
      const expandable = !!n.children?.length || !!n.lazy || !!extra?.length;
      const isOpen = open.has(n.id);
      const info: DrillCellInfo = { depth, leaf: !expandable, open: isOpen };
      const selectBy = owner ?? n;
      const state = selectable ? DrillTree.selectionState(selectBy, sel) : 'none';
      const cell = (col: number): CSSProperties | undefined => {
        if (!rainbow) return undefined;
        const c = drillCellColor(hue, depth, col);
        return { background: c.css, color: drillTextColor(hue, c.s, c.l) };
      };
      const box = selectable ? (
        <input className="arc-drill-check" type="checkbox" checked={state === 'all'} aria-checked={state === 'some' ? 'mixed' : state === 'all'}
          ref={el => { if (el) el.indeterminate = state === 'some'; }} aria-label={`Select ${n.label}`}
          onChange={e => onSelect?.(DrillTree.leafIds(selectBy), e.target.checked)} />
      ) : null;
      const count = n.children?.length ? DrillTree.countOf(n) : null;
      out.push(
        <tr key={n.id} className="arc-drill-tr" data-depth={depth}>
          <td style={cell(0)}>
            <div className="arc-drill-name" style={{ paddingLeft: 8 + depth * 18 }}>
              {box}
              {expandable ? (
                <button type="button" className="arc-drill-toggle-row" aria-expanded={isOpen} onClick={() => toggleOpen(n)}>
                  <span className="arc-drill-chevron" aria-hidden="true">›</span><span className="arc-drill-label">{n.label}</span>
                  {nameExtra?.(n, info)}
                  {count !== null && <span className="arc-drill-count">{count.toLocaleString()}</span>}
                </button>
              ) : (
                <span className="arc-drill-leaf">
                  <span className="arc-drill-chevron" aria-hidden="true">•</span><span className="arc-drill-label">{n.label}</span>
                  {nameExtra?.(n, info)}
                </span>
              )}
            </div>
          </td>
          {columns.map((c, ci) => (
            <td key={c.id} className={c.className} style={{ ...cell(ci + 1), textAlign: c.align }}>{c.cell(n, info)}</td>
          ))}
        </tr>,
      );
      if (isOpen) {
        if (lazyKids === 'loading') out.push(<tr key={`${n.id}/loading`}><td colSpan={colCount}><div className="arc-drill-empty">Loading…</div></td></tr>);
        else if (typeof lazyKids === 'string') out.push(<tr key={`${n.id}/err`}><td colSpan={colCount}><div className="arc-drill-empty">{lazyKids}</div></td></tr>);
        else if (kids?.length) out.push(...rows(kids, depth + 1, hue, n.id, kids === extra ? n : owner));
        else if (n.lazy && Array.isArray(lazyKids)) out.push(<tr key={`${n.id}/none`}><td colSpan={colCount}><div className="arc-drill-empty">Nothing beneath this row.</div></td></tr>);
      }
    });
    if (ns.length > limit) {
      out.push(
        <tr key={`${path}/more`}><td colSpan={colCount}>
          <button type="button" className="arc-drill-more" style={{ marginLeft: 8 + depth * 18 }}
            onClick={() => setShown(s => ({ ...s, [path]: limit + pageSize }))}>
            Show {Math.min(pageSize, ns.length - limit).toLocaleString()} more of {(ns.length - limit).toLocaleString()}
          </button>
        </td></tr>,
      );
    }
    return out;
  }

  return (
    <div className={`arc-drill arc-drill--${theme}${rainbow ? ' is-rainbow' : ''}${className ? ` ${className}` : ''}`}>
      <table className="arc-drill-table" aria-label={ariaLabel}>
        <thead><tr>
          <th scope="col">{nameTitle}</th>
          {columns.map(c => <th key={c.id} scope="col" style={{ width: c.width, textAlign: c.align }}>{c.title}</th>)}
        </tr></thead>
        <tbody>
          {list.length ? rows(list, 0, null, 'root').map((r, i) => <Fragment key={i}>{r}</Fragment>)
            : <tr><td colSpan={colCount}><div className="arc-drill-empty">{empty ?? 'Nothing to show.'}</div></td></tr>}
        </tbody>
      </table>
    </div>
  );
}
