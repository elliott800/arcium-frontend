// Plain-language names for the Data Hub page: what each source is, what each request key records, and what each data
// rate code means. Shared by the page and its API (no server imports).

export interface SourceName { name: string; about: string }

export const SOURCE_NAMES: Record<string, SourceName> = {
  webull_stocks: { name: 'Webull', about: 'Stock and ETF price bars (4-hour, daily, weekly, monthly)' },
  yahoo: { name: 'Yahoo Finance', about: 'Price history, valuation, option chains, breadth and the dollar index' },
  sec_edgar: { name: 'SEC EDGAR', about: 'Company financials, filings and report text' },
  oanda_practice: { name: 'OANDA', about: 'Every currency pair: price bars, order and position books' },
  fred: { name: 'FRED', about: 'Economic series from the St. Louis Fed' },
  cftc_cot: { name: 'CFTC', about: 'Commitments of Traders positioning' },
  cboe: { name: 'Cboe', about: 'Put/call ratios' },
  holdings: { name: 'Fund holdings', about: "What each tracked fund holds" },
  datahub: { name: 'Data Hub bot', about: 'Stats and filing ticks calculated from the warehouse' },
};

export const sourceName = (connection: string) => SOURCE_NAMES[connection]?.name ?? connection;
export const sourceAbout = (connection: string) => SOURCE_NAMES[connection]?.about ?? '';

const KEY_NAMES: Record<string, string> = {
  candles: 'Price bars', 'stocks.candles': 'Price bars', 'etfs.candles': 'Price bars', 'options.chain': 'Option chain',
  'stocks.fundamentals': 'Fundamentals', 'stocks.valuation': 'Valuation', 'breadth.above_ma': 'Market breadth',
  facts: 'Financial statements', filings: 'Filings', reports: 'Report text', series: 'Economic series',
  orderbook: 'Order book', positionbook: 'Position book', positions: 'Positioning', putcall: 'Put/call ratio',
  stats: 'Stock stats',
};

/** What a request key records, in plain words (the Data Hub bot's 'filings' key is its filing ticks). */
export function keyName(connection: string, key: string): string {
  if (connection === 'datahub' && key === 'filings') return 'Filing ticks (8-K, Form 4, 13D)';
  if (key.endsWith('holdings')) return 'Fund holdings';
  return KEY_NAMES[key] ?? key;
}

const RATE_NAMES: Record<string, string> = {
  Tick: 'each event', S5: '5 seconds', S10: '10 seconds', S15: '15 seconds', S30: '30 seconds',
  M1: '1 minute', M2: '2 minutes', M4: '4 minutes', M5: '5 minutes', M10: '10 minutes', M15: '15 minutes', M30: '30 minutes',
  H1: '1 hour', H2: '2 hours', H3: '3 hours', H4: '4 hours', H6: '6 hours', H8: '8 hours', H12: '12 hours',
  D: 'daily', W: 'weekly', M: 'monthly',
};

/** A data rate code in words: H4 -> "4 hours", D -> "daily". */
export const rateName = (code: string | null | undefined) => (code ? RATE_NAMES[code] ?? code : '');

/** "3 min ago", "5 h ago", "2 d ago" (or '' for no time). */
export function ago(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
}
