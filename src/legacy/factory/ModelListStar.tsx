'use client';

// The ★ beside a model, as in Webull's watchlist manager: filled when the model is in any favourites list; a
// click opens a checklist of every list to tick (add) or untick (remove), plus a new list. Used in the
// optimization results, the Models Catalog and the favourites panel beside the engines.

import { useEffect, useRef, useState } from 'react';

/** Where to draw a popover for a button: fixed to the window (so a scrolling table can't clip it), below the
 *  button or above it when there's no room, kept on screen. */
export function popoverAt(btn: HTMLElement | null, width = 240, height = 280): React.CSSProperties {
  if (!btn) return {};
  const r = btn.getBoundingClientRect();
  const below = window.innerHeight - r.bottom > height || r.top < height;
  return {
    position: 'fixed', zIndex: 1000, width,
    left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)),
    ...(below ? { top: r.bottom + 4 } : { bottom: window.innerHeight - r.top + 4 }),
    maxHeight: Math.max(160, below ? window.innerHeight - r.bottom - 16 : r.top - 16), overflowY: 'auto',
  };
}

/** The key the server compares favourite rows by (src/lib/db.ts updateUserModelFavoriteList). */
export function modelKey(row: any): string {
  return [
    row?.model_hash ?? row?.blob_hash ?? row?.hash ?? row?.constructor_ref ?? '',
    row?.catalog_source ?? '',
    row?.signal_name ?? row?.model_name ?? '',
    row?.instrument_name ?? '',
    row?.data_rate ?? '',
  ].join('|');
}

export function listsHolding(row: any, favorites: Record<string, any[]>): string[] {
  const k = modelKey(row);
  return Object.entries(favorites).filter(([, rows]) => Array.isArray(rows) && rows.some(r => modelKey(r) === k)).map(([n]) => n);
}

export default function ModelListStar({ row, favorites, onToggle, onCreate }: {
  row: any;
  favorites: Record<string, any[]>;
  onToggle: (list: string, add: boolean) => void;
  onCreate: (name: string) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<React.CSSProperties>({});   // where the popover sits, measured when it opens
  const [name, setName] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const holding = listsHolding(row, favorites);
  const lists = [...new Set(['favorites', ...Object.keys(favorites)])];

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const close = () => setOpen(false);                 // a fixed popover would drift from its row on scroll
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close);
    };
  }, [open]);

  return (
    <div className="fx-star" ref={box} onClick={e => e.stopPropagation()}>
      <button ref={btn} type="button" className={`fx-star-btn${holding.length ? ' on' : ''}`} aria-haspopup="true" aria-expanded={open}
        title={holding.length ? `In ${holding.join(', ')}` : 'Add to a favourites list'} onClick={() => { if (!open) setPos(popoverAt(btn.current)); setOpen(!open); }}>
        {holding.length ? '★' : '☆'}
      </button>
      {open && (
        <div className="fx-star-pop" role="dialog" aria-label="Favourite lists" style={pos}>
          <div className="fx-star-title">Lists</div>
          {lists.map(l => (
            <label key={l} className="fx-star-item">
              <input type="checkbox" checked={holding.includes(l)} onChange={e => onToggle(l, e.target.checked)} />
              <span>{l}</span>
              <small>{Array.isArray(favorites[l]) ? favorites[l].length : 0}</small>
            </label>
          ))}
          <form className="fx-star-new" onSubmit={async e => {
            e.preventDefault();
            const n = name.trim();
            if (!n) return;
            await onCreate(n);
            onToggle(n, true);
            setName('');
          }}>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="New list" aria-label="New list name" maxLength={40} />
            <button type="submit" disabled={!name.trim()}>Add</button>
          </form>
        </div>
      )}
    </div>
  );
}
