'use client';

// The Data Hub's drill tables: the site's standard rainbow drill table (src/ui/drill/DrillTable.tsx) with the Data Hub
// columns: Source, Format and Contents, then an optional rate column and action column.

import type { ReactNode } from 'react';
import StandardDrillTable, { DrillPill, type DrillColumn } from '@/ui/drill/DrillTable';
import { DrillTree } from '@/lib/drillTree';
import type { DhNode } from '@/lib/datahubTypes';

export const leafIds = (n: DhNode) => DrillTree.leafIds(n);

export interface DrillColumns {
  first: string;
  rate?: { title: string; cell: (n: DhNode) => ReactNode };
  action?: { title: string; cell: (n: DhNode) => ReactNode };
}

export default function DrillTable({ nodes, columns, rainbow, selectable, selected, onSelect, loadChildren, empty, expandLeaves }: {
  nodes: DhNode[];
  columns: DrillColumns;
  rainbow: boolean;
  selectable?: boolean;
  selected?: Set<string>;
  onSelect?: (ids: string[], checked: boolean) => void;
  loadChildren?: (n: DhNode) => Promise<DhNode[]>;
  empty?: string;
  expandLeaves?: (n: DhNode) => DhNode[] | null;
}) {
  // Branch rows stay quiet: no placeholder dashes, just how many items they hold.
  const branchMeta = (n: DhNode) => {
    const c = DrillTree.countOf(n);
    return <span className="dhx-branch-meta">{c.toLocaleString()} item{c === 1 ? '' : 's'}</span>;
  };
  const cols: DrillColumn<DhNode>[] = [
    { id: 'source', title: 'Source', cell: (n, i) => n.source ?? (i.leaf ? '—' : '') },
    { id: 'format', title: 'Format', cell: (n, i) => n.format ?? (i.leaf ? '—' : '') },
    { id: 'contents', title: 'Contents', cell: (n, i) => n.contents ?? (i.leaf ? '—' : branchMeta(n)) },
    ...(columns.rate ? [{ id: 'rate', title: columns.rate.title, cell: columns.rate.cell, className: 'dhx-rate-cell' }] : []),
    ...(columns.action ? [{ id: 'action', title: columns.action.title, cell: columns.action.cell, className: 'dhx-action-cell' }] : []),
  ];
  return (
    <StandardDrillTable<DhNode> nodes={nodes} nameTitle={columns.first} columns={cols} rainbow={rainbow} theme="light"
      selectable={selectable} selected={selected} onSelect={onSelect} loadChildren={loadChildren} expandLeaf={expandLeaves}
      nameExtra={n => (n.source && n.label !== n.source ? <DrillPill>{n.source}</DrillPill> : null)}
      empty={empty ?? 'No data matches these filters. Try a different source or tag search.'} />
  );
}
