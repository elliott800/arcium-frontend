// What each Data Hub dataset holds for one symbol (pure: the route reads the counts, this decides the status).
// The datasets are the ones in DATAHUB.md: fundamentals, ratios, estimates and SUE, and filing text.

export interface DatasetCounts {
  secConcepts: number;      // SEC fact concepts recorded for the symbol
  secRows: number;          // SEC fact values recorded
  secFirst: string | null;  // earliest filing date (YYYY-MM-DD)
  secLast: string | null;   // latest filing date
  yahooRows: number;        // Yahoo statement line items
  valuationRows: number;    // Yahoo statistics snapshots
  estimateRows: number;     // earnings estimates and announcements
  filingRows: number;       // SEC filings with events
}

export type DatasetStatus = 'available' | 'partial' | 'not recorded';

export interface DatasetAvailability {
  id: 'fundamentals' | 'ratios' | 'sue' | 'filings_text';
  title: string;
  status: DatasetStatus;
  rows: number;
  first: string | null;
  last: string | null;
  note: string;
}

export function summarizeDatasets(c: DatasetCounts): DatasetAvailability[] {
  const fundamentals: DatasetAvailability = c.secRows > 0
    ? { id: 'fundamentals', title: 'Fundamentals with rolling ratios', status: 'available', rows: c.secRows, first: c.secFirst, last: c.secLast,
        note: `${c.secConcepts} SEC concepts, point-in-time by filing date` }
    : c.yahooRows > 0
      ? { id: 'fundamentals', title: 'Fundamentals with rolling ratios', status: 'partial', rows: c.yahooRows, first: null, last: null,
          note: 'Yahoo statements only; no SEC filing history' }
      : { id: 'fundamentals', title: 'Fundamentals with rolling ratios', status: 'not recorded', rows: 0, first: null, last: null, note: 'No statements recorded' };
  const ratios: DatasetAvailability = {
    id: 'ratios', title: 'Ratios on daily dates',
    status: fundamentals.status === 'not recorded' ? 'not recorded' : fundamentals.status,
    rows: fundamentals.rows, first: fundamentals.first, last: fundamentals.last,
    note: c.valuationRows > 0
      ? `Computed from fundamentals and the daily close; cross-checked against ${c.valuationRows} Yahoo statistics snapshots`
      : 'Computed from fundamentals and the daily close',
  };
  const sue: DatasetAvailability = c.estimateRows > 0
    ? { id: 'sue', title: 'Earnings estimates and SUE', status: 'available', rows: c.estimateRows, first: null, last: null, note: 'SUE at 3m, 2m, 1m and day-of' }
    : { id: 'sue', title: 'Earnings estimates and SUE', status: 'not recorded', rows: 0, first: null, last: null,
        note: 'Estimates are not recorded yet; the SUE calculation is ready' };
  const filings: DatasetAvailability = c.filingRows > 0
    ? { id: 'filings_text', title: 'Filing text with sentiment and impact', status: 'partial', rows: c.filingRows, first: null, last: null,
        note: 'Filings and events recorded; text sentiment and impact are not built yet' }
    : { id: 'filings_text', title: 'Filing text with sentiment and impact', status: 'not recorded', rows: 0, first: null, last: null, note: 'No filings recorded' };
  return [fundamentals, ratios, sue, filings];
}

// ---- CSV export ---------------------------------------------------------------------------------------

export interface FactRow { concept: string; available: string; value: number | null }

/** CSV of SEC fact rows: concept, the date the value became public, the value. Quotes any field that needs it. */
export function factsCsv(rows: FactRow[]): string {
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return ['concept,available,value', ...rows.map(r => [r.concept, r.available, r.value].map(esc).join(','))].join('\n') + '\n';
}
