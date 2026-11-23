'use client';

// A content table whose columns sort on click (or Enter / Space on the header button): ascending, descending,
// then back to the order the owner wrote. Cells that read as numbers ("0.26", "−0.12", "3.5x", "12%") sort as
// numbers; the rest sort as text.

import { useMemo, useState } from 'react';

type Dir = 'ascending' | 'descending';

const num = (s: string) => {
  const m = s.replace(/[−‒–]/g, '-').replace(/,/g, '').match(/^\s*([-+]?\d*\.?\d+)/);
  return m ? Number(m[1]) : null;
};

export default function SortableTable({ columns, rows, caption }: { columns: string[]; rows: string[][]; caption?: string }) {
  const [sort, setSort] = useState<{ col: number; dir: Dir } | null>(null);

  const shown = useMemo(() => {
    const keyed = rows.map((r, at) => ({ r, at }));
    if (!sort) return keyed;
    const { col, dir } = sort;
    const allNum = rows.every(r => !r[col] || num(r[col]) !== null);
    const sign = dir === 'ascending' ? 1 : -1;
    return keyed.sort(({ r: a }, { r: b }) => {
      const x = a[col] ?? '', y = b[col] ?? '';
      if (!x || !y) return x ? -1 : y ? 1 : 0;              // empty cells stay at the bottom either way
      return sign * (allNum ? num(x)! - num(y)! : x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' }));
    });
  }, [rows, sort]);

  const next = (col: number) => setSort(s => (s?.col !== col ? { col, dir: 'ascending' } : s.dir === 'ascending' ? { col, dir: 'descending' } : null));

  return (
    <div className="fu-table-wrap">
      <table className="fu-table">
        {caption ? <caption className="fu-sr">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={c} scope="col" aria-sort={sort?.col === i ? sort.dir : 'none'}>
                <button type="button" className="fu-sort" onClick={() => next(i)}
                  title={sort?.col === i ? (sort.dir === 'ascending' ? 'Sorted ascending; click for descending' : 'Sorted descending; click for the original order') : `Sort by ${c}`}>
                  {c}<span className="fu-sort-mark" aria-hidden="true">{sort?.col === i ? (sort.dir === 'ascending' ? '▲' : '▼') : '↕'}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map(({ r, at }) => (
            <tr key={at}>
              {columns.map((c, j) => (j === 0 ? <th key={c} scope="row">{r[j]}</th> : <td key={c}>{r[j]}</td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
