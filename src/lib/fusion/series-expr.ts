// How Fusion content names a data series (see series.ts): `fred:ID[@as]`, `price:SYMBOL[@as]`, `putcall:RATIO`
// (Cboe: total, equity, index), `breadth:FUND` (% of the fund's members above their 50-week average), or the
// difference of two of them, `A - B`. Kept apart from the loader so the content checks need no database.

export const SERIES_PART = /^(fred|price|putcall|breadth):([A-Za-z0-9._^=-]{1,24})(?:@(level|yoy|change|qoq_ann))?$/;

export function seriesParts(expr: string): string[] {
  return expr.split(/\s+[-/]\s+/).map(s => s.trim());
}

/** How the two parts combine: 'ratio' for "A / B", 'difference' for "A - B". */
export function seriesOp(expr: string): 'difference' | 'ratio' {
  return /\s+\/\s+/.test(expr) ? 'ratio' : 'difference';
}

export function validSeriesExpr(expr: string): boolean {
  const parts = seriesParts(expr);
  return parts.length >= 1 && parts.length <= 2 && parts.every(p => SERIES_PART.test(p));
}
