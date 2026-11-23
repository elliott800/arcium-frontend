// The Arcium chart (public/arcium-chart.js) for React pages: the same file the other Arcium sites
// load, so there is one chart everywhere. It's loaded once, on first use.

export interface ChartPoint { t: number; o?: number; h?: number; l?: number; c?: number; v?: number }
export interface ChartSeriesInput { id: string; name?: string; color?: string; area?: boolean; data: ChartPoint[] }
export interface ChartData {
  mode?: 'candles' | 'line' | 'compare' | 'ratio';
  series: ChartSeriesInput[];
  volume?: boolean;
  lines?: { y: number; color?: string; label?: string; dash?: number[]; fit?: boolean }[];
  bands?: { color?: string; data: { t: number; m: number; u: number; l: number }[] };
  format?: (v: number) => string;
  timeFormat?: (t: number) => string;
  keepView?: boolean;
  /** the interval of the bars handed in, e.g. 'M5', 'D' (else measured from their spacing) */
  rate?: string;
}
export interface ArciumChartApi {
  setData(d: ChartData): ArciumChartApi; redraw(): void; resetView(): void; destroy(): void; canvas: HTMLCanvasElement;
  choices(): { interval: string | null; range: string | null };
}
/** The controls strip: Interval (M1 M5 M15 M30 H1 H4 D W M) and Show (1D 5D 1M 3M 6M YTD 1Y 2Y 5Y All). */
export interface ChartControls { interval?: string; range?: string; onInterval?: (rate: string) => void }
interface ArciumChartLib {
  create(el: HTMLElement, opts?: { height?: number | string; empty?: string; controls?: boolean | ChartControls }): ArciumChartApi;
  palette: string[];
}

let loading: Promise<ArciumChartLib> | null = null;

export function loadArciumChart(): Promise<ArciumChartLib> {
  const w = window as unknown as { ArciumChart?: ArciumChartLib };
  if (w.ArciumChart) return Promise.resolve(w.ArciumChart);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/arcium-chart.js';
    s.onload = () => (w.ArciumChart ? resolve(w.ArciumChart) : reject(new Error('arcium-chart.js loaded without ArciumChart')));
    s.onerror = () => { loading = null; reject(new Error('could not load /arcium-chart.js')); };
    document.head.appendChild(s);
  });
  return loading;
}
