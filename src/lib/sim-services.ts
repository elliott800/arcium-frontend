// The simulated Services Hub: answers the /v1 API that the Services Hub and Arcade pages (public/services/) call, so
// `npm run sim` runs them with no Fusion Hub. Reached through src/app/api/sim/services/[...path]/route.ts, which
// src/proxy.ts rewrites serviceshub.localhost and arcade.localhost /v1 calls to; it answers only on the simulated
// database. The real service is Fusion Hub (Python, private); this follows its published rules and response shapes
// (contract/hooks.json "services_api", explained in contract/README.md) with simulated prices and sample scanner data.
//
//   accounts    the site's own users: Sign in with Arcium (a pass from /sso, client "fusionhub") or email + password,
//               then a bearer token, as Fusion Hub does
//   arcade      practice accounts: forex at 50:1, shares (short holds 50% margin), long options at the ask (100 a
//               contract); every position expires; close early at spot or the bid
//   trader      a trader profile, locked predictions scored against daily highs and lows, a calendar, and sample
//               FUll SCAN sections in the shape the Trader page reads (the real scanner data stays private)

import { randomBytes } from 'crypto';
import { getDb, verifyPassword } from '@/lib/db';
import { getUserByLogin } from '@/lib/signup';
import { verifyPass } from '@/lib/sso';

type Json = Record<string, unknown>;
export class SimServicesError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
const fail = (status: number, message: string, code?: string): never => { throw new SimServicesError(status, message, code); };
const db = () => getDb();

// ── storage (in the simulated database) ──
let ready: Promise<void> | null = null;
function setup(): Promise<void> {
  ready ??= db().exec(`
    CREATE TABLE IF NOT EXISTS sim_fh_tokens (token text PRIMARY KEY, username text NOT NULL, email text NOT NULL,
      role text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS sim_fh_arcade_accounts (id serial PRIMARY KEY, username text NOT NULL, name text NOT NULL,
      start_balance double precision NOT NULL, balance double precision NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS sim_fh_arcade_positions (id serial PRIMARY KEY, account_id integer NOT NULL
      REFERENCES sim_fh_arcade_accounts(id) ON DELETE CASCADE, kind text NOT NULL, symbol text NOT NULL, label text NOT NULL,
      side text NOT NULL, qty double precision NOT NULL, open_price double precision NOT NULL,
      opened_at timestamptz NOT NULL DEFAULT now(), expires date NOT NULL, reserved double precision NOT NULL, option jsonb,
      status text NOT NULL DEFAULT 'open', close_price double precision, closed_at timestamptz, pnl double precision);
    CREATE TABLE IF NOT EXISTS sim_fh_trader_profiles (username text PRIMARY KEY, settings jsonb NOT NULL DEFAULT '{}',
      secrets_set jsonb NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS sim_fh_predictions (id serial PRIMARY KEY, username text NOT NULL, ticker text NOT NULL,
      ref_price double precision NOT NULL, targets jsonb NOT NULL, note text, locked_at timestamptz NOT NULL DEFAULT now(),
      until_date date NOT NULL, cash double precision, cash_rate double precision, cash_source text,
      status text NOT NULL DEFAULT 'open', loss double precision, resolved_at timestamptz);
  `).catch(e => { ready = null; throw e; });
  return ready;
}

// ── simulated market ──
const FOREX: Record<string, [string, string, string]> = {
  'EURUSD=X': ['EUR/USD', 'EUR', 'USD'], 'GBPUSD=X': ['GBP/USD', 'GBP', 'USD'], 'USDJPY=X': ['USD/JPY', 'USD', 'JPY'],
  'AUDUSD=X': ['AUD/USD', 'AUD', 'USD'], 'USDCAD=X': ['USD/CAD', 'USD', 'CAD'],
};
const STOCKS = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'META'];
const BASE: Record<string, number> = {
  'EURUSD=X': 1.08, 'GBPUSD=X': 1.27, 'USDJPY=X': 151.2, 'AUDUSD=X': 0.66, 'USDCAD=X': 1.37,
  SPY: 590, QQQ: 505, AAPL: 228, MSFT: 415, NVDA: 142, TSLA: 340, AMZN: 200, META: 560,
};
const DAY = 86_400_000;
const ANCHOR = Math.floor(Date.UTC(2025, 0, 1) / DAY);           // the simulated series start here
const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function noise(seed: number): number {                          // a standard normal from a seed (Box-Muller)
  const r = (n: number) => { let t = (n + 0x6D2B79F5) >>> 0; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (((t ^ (t >>> 14)) >>> 0) + 1) / 4294967297; };
  return Math.sqrt(-2 * Math.log(r(seed))) * Math.cos(2 * Math.PI * r(seed ^ 0x9E3779B9));
}
const isForex = (s: string) => s in FOREX;
const vol = (s: string) => (isForex(s) ? 0.005 : 0.018);
const base = (s: string) => BASE[s] ?? 20 + (hash(s) % 38000) / 100;
const closes = new Map<string, number[]>();

/** Daily closes from ANCHOR to `day` (inclusive): a deterministic random walk per symbol that drifts back toward its
 *  usual level (so a pair or a share stays near a believable price however long the simulation runs). */
function series(symbol: string, day: number): number[] {
  const out = closes.get(symbol) ?? [base(symbol)];
  const h = hash(symbol), b = base(symbol);
  while (out.length <= day - ANCHOR) {
    const x = Math.log(out[out.length - 1] / b);
    out.push(b * Math.exp(0.97 * x + vol(symbol) * noise(h + out.length * 7919)));
  }
  closes.set(symbol, out);
  return out;
}
const today = () => Math.floor(Date.now() / DAY);
const closeOn = (symbol: string, day: number) => series(symbol, Math.max(day, ANCHOR))[Math.max(day, ANCHOR) - ANCHOR];
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const pxRound = (s: string, v: number) => round(v, isForex(s) ? (v > 20 ? 3 : 5) : 2);

/** Spot now: from yesterday's close toward today's, with a little minute-to-minute movement. */
function spot(symbol: string): { price: number; changePct: number } {
  const d = today(), prev = closeOn(symbol, d - 1), close = closeOn(symbol, d);
  const f = (Date.now() % DAY) / DAY, minute = Math.floor(Date.now() / 60_000);
  const p = prev * Math.pow(close / prev, f) * (1 + vol(symbol) * 0.05 * noise(hash(symbol) + minute));
  return { price: pxRound(symbol, p), changePct: round((p / prev - 1) * 100, 3) };
}
function bar(symbol: string, day: number) {
  const o = closeOn(symbol, day - 1), c = closeOn(symbol, day), w = vol(symbol) * Math.abs(noise(hash(symbol) + day));
  return { t: day * DAY / 1000, o, c, h: Math.max(o, c) * (1 + w / 2), l: Math.min(o, c) * (1 - w / 2) };
}
function needSymbol(v: unknown): string {
  const s = String(v ?? '').trim().toUpperCase();
  if (isForex(s)) return s;
  if (!SYMBOL_RE.test(s)) fail(400, 'Give a ticker, e.g. AAPL.');
  return s;
}

// Options: Fridays for six weeks, strikes around spot, prices from Black-Scholes at 30% volatility.
const isoDay = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
const dayOf = (iso: string) => Math.floor(Date.parse(iso + 'T00:00:00Z') / DAY);
function expirations(): string[] {
  const out: string[] = [];
  for (let d = today() + 1; out.length < 6; d++) if (new Date(d * DAY).getUTCDay() === 5) out.push(isoDay(d));
  return out;
}
function ncdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
function bs(right: 'call' | 'put', s: number, k: number, years: number): number {
  const v = 0.3, r = 0.04, t = Math.max(years, 1 / 365);
  const d1 = (Math.log(s / k) + (r + v * v / 2) * t) / (v * Math.sqrt(t)), d2 = d1 - v * Math.sqrt(t);
  return right === 'call' ? s * ncdf(d1) - k * Math.exp(-r * t) * ncdf(d2) : k * Math.exp(-r * t) * ncdf(-d2) - s * ncdf(-d1);
}
interface ChainRow { strike: number; bid: number; ask: number; lastPrice: number; contractSymbol: string }
function chain(symbol: string, expiration: string): { calls: ChainRow[]; puts: ChainRow[] } {
  const s = spot(symbol).price, step = s < 50 ? 1 : s < 200 ? 2.5 : s < 500 ? 5 : 10;
  const years = (dayOf(expiration) - today()) / 365, mid = Math.round(s / step) * step;
  const rows = (right: 'call' | 'put') => Array.from({ length: 41 }, (_, i) => mid + (i - 20) * step).filter(k => k > 0).map(k => {
    const p = Math.max(0.01, bs(right, s, k, years));
    return { strike: k, bid: round(Math.max(0.01, p * 0.97)), ask: round(p * 1.03 + 0.01), lastPrice: round(p),
      contractSymbol: `${symbol}${expiration.slice(2).replace(/-/g, '')}${right === 'call' ? 'C' : 'P'}${String(Math.round(k * 1000)).padStart(8, '0')}` };
  });
  return { calls: rows('call'), puts: rows('put') };
}
function contract(symbol: string, expiration: string, right: string, strike: number): ChainRow {
  if (!expirations().includes(expiration) && dayOf(expiration) > today()) fail(404, `No ${symbol} options expire on ${expiration}.`);
  const row = chain(symbol, expiration)[right === 'call' ? 'calls' : 'puts'].find(r => Math.abs(r.strike - strike) < 1e-6);
  return row ?? fail(404, `No ${symbol} ${right} ${strike} option expiring ${expiration}.`);
}

// ── accounts ──
interface User { username: string; email: string; role: string }
async function issue(u: User) {
  const token = randomBytes(24).toString('hex');
  await db().prepare('INSERT INTO sim_fh_tokens (token, username, email, role) VALUES (?, ?, ?, ?)').run(token, u.username, u.email, u.role);
  return { token, email: u.email, role: u.role };
}
async function userFor(auth: string | null): Promise<User & { token: string }> {
  const token = (auth ?? '').replace(/^Bearer\s+/i, '').trim();
  const u = token ? await db().prepare('SELECT * FROM sim_fh_tokens WHERE token = ?').get(token) as (User & { token: string }) | undefined : undefined;
  return u ?? fail(401, 'Please sign in.', 'AUTH');
}

// ── arcade ──
const FX_LEVERAGE = 50, SHORT_MARGIN = 0.5, MULTIPLIER = 100;
interface Position { id: number; account_id: number; kind: string; symbol: string; label: string; side: string; qty: number;
  open_price: number; opened_at: string | Date; expires: string | Date; reserved: number; option: { right: string; strike: number } | string | null;
  status: string; close_price: number | null; pnl: number | null }
const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : String(v));
const dateOnly = (v: string | Date) => iso(v).slice(0, 10);
const opt = (p: Position) => (typeof p.option === 'string' ? JSON.parse(p.option) : p.option) as { right: string; strike: number };

async function account(username: string, id: unknown) {
  const a = await db().prepare('SELECT * FROM sim_fh_arcade_accounts WHERE id = ? AND username = ?').get(Number(id) || 0, username) as
    { id: number; name: string; start_balance: number; balance: number } | undefined;
  return a ?? fail(404, 'No such arcade account.');
}
function pnl(p: Position, exit: number): number {
  const sign = p.side === 'long' ? 1 : -1;
  if (p.kind === 'forex') { const quoteUsd = FOREX[p.symbol][2] === 'USD'; const v = (exit - p.open_price) * p.qty * sign; return quoteUsd ? v : v / exit; }
  if (p.kind === 'stock') return (exit - p.open_price) * p.qty * sign;
  return (exit - p.open_price) * MULTIPLIER * p.qty;
}
async function settle(p: Position, exit: number, status: string) {
  const v = round(pnl(p, exit));
  await db().prepare("UPDATE sim_fh_arcade_positions SET status = ?, close_price = ?, closed_at = now(), pnl = ? WHERE id = ? AND status = 'open'")
    .run(status, exit, v, p.id);
  await db().prepare('UPDATE sim_fh_arcade_accounts SET balance = balance + ? WHERE id = ?').run(Math.max(p.reserved + v, 0), p.account_id);
}
function mark(p: Position): number {
  if (p.kind !== 'option') return spot(p.symbol).price;
  const o = opt(p), r = contract(p.symbol, dateOnly(p.expires), o.right, o.strike);
  return (r.bid + r.ask) / 2;
}
async function positions(username: string, accountId: unknown) {
  let a = await account(username, accountId);
  const due = await db().prepare("SELECT * FROM sim_fh_arcade_positions WHERE account_id = ? AND status = 'open' AND expires < CURRENT_DATE")
    .all(a.id) as Position[];
  for (const p of due) {
    const under = closeOn(p.symbol, dayOf(dateOnly(p.expires)));
    const o = p.kind === 'option' ? opt(p) : null;
    await settle(p, o ? Math.max(0, o.right === 'call' ? under - o.strike : o.strike - under) : under, 'expired');
  }
  a = await account(username, a.id);
  const rows = await db().prepare("SELECT * FROM sim_fh_arcade_positions WHERE account_id = ? ORDER BY (status = 'open') DESC, opened_at DESC LIMIT 300")
    .all(a.id) as Position[];
  let unrealized = 0;
  const out = rows.map(p => {
    const item: Json = { id: p.id, kind: p.kind, symbol: p.symbol, label: p.label, side: p.side, qty: p.qty, openPrice: p.open_price,
      openedAt: iso(p.opened_at), expires: dateOnly(p.expires), reserved: round(p.reserved), status: p.status, closePrice: p.close_price, pnl: p.pnl };
    if (p.status === 'open') {
      let m: number | null = null;
      try { m = mark(p); } catch { m = null; }
      item.mark = m; item.unrealized = m == null ? null : round(pnl(p, m));
      unrealized += (item.unrealized as number | null) ?? 0;
    }
    return item;
  });
  const held = rows.filter(r => r.status === 'open').reduce((s, r) => s + r.reserved, 0);
  const equity = a.balance + held + unrealized;
  return { account: { id: a.id, name: a.name, startBalance: a.start_balance, cash: round(a.balance), held: round(held),
    unrealized: round(unrealized), equity: round(equity), returnPct: round((equity / a.start_balance - 1) * 100, 3) }, positions: out };
}
async function accounts(username: string) {
  const rows = await db().prepare(`
    SELECT a.*, COALESCE(SUM(p.reserved) FILTER (WHERE p.status = 'open'), 0) AS held,
           COALESCE(SUM(p.pnl) FILTER (WHERE p.status <> 'open'), 0) AS realized,
           COUNT(p.id) FILTER (WHERE p.status = 'open') AS open_positions
    FROM sim_fh_arcade_accounts a LEFT JOIN sim_fh_arcade_positions p ON p.account_id = a.id
    WHERE a.username = ? GROUP BY a.id ORDER BY a.id`).all(username) as
    { id: number; name: string; start_balance: number; balance: number; held: number; realized: number; open_positions: number | string }[];
  return { accounts: rows.map(a => ({ id: a.id, name: a.name, startBalance: a.start_balance, cash: round(a.balance), held: round(Number(a.held)),
    realized: round(Number(a.realized)), openPositions: Number(a.open_positions), returnPct: round(Number(a.realized) / a.start_balance * 100, 3) })) };
}

async function arcade(route: string, method: string, args: Json, u: User): Promise<Json> {
  const key = `${method} ${route}`;
  if (key === 'GET banner') {
    return { instruments: [...Object.entries(FOREX).map(([s, f]) => ({ symbol: s, label: f[0], kind: 'forex' })),
      ...STOCKS.map(s => ({ symbol: s, label: s, kind: 'stock' }))].map(i => ({ ...i, ...spot(i.symbol) })) };
  }
  if (key === 'GET quote') {
    const s = needSymbol(args.symbol), kind = isForex(s) ? 'forex' : 'stock';
    return { symbol: s, label: kind === 'forex' ? FOREX[s][0] : s, kind, ...spot(s) };
  }
  if (key === 'GET options') {
    const s = needSymbol(args.symbol);
    if (isForex(s)) fail(400, 'Options are for stocks.');
    const exps = expirations(), exp = args.expiration ? String(args.expiration) : '';
    if (!exp) return { symbol: s, expirations: exps };
    if (!exps.includes(exp)) fail(400, `No ${s} options expire on ${exp}.`);
    const sp = spot(s).price, c = chain(s, exp);
    const near = (rows: ChainRow[]) => {
      const i = rows.reduce((b, r, k) => (Math.abs(r.strike - sp) < Math.abs(rows[b].strike - sp) ? k : b), 0);
      return rows.slice(Math.max(0, i - 12), i + 13).map(r => ({ strike: r.strike, bid: r.bid, ask: r.ask, last: r.lastPrice }));
    };
    return { symbol: s, expiration: exp, spot: sp, calls: near(c.calls), puts: near(c.puts) };
  }
  if (key === 'GET accounts') return accounts(u.username);
  if (key === 'POST accounts') {
    const name = String(args.name ?? '').trim().slice(0, 40) || 'Account', bal = Number(args.balance);
    if (!(bal > 0 && bal <= 100_000_000)) fail(400, 'Starting balance must be between $1 and $100,000,000.');
    const n = await db().prepare('SELECT count(*) AS n FROM sim_fh_arcade_accounts WHERE username = ?').get(u.username) as { n: number | string };
    if (Number(n.n) >= 50) fail(400, "That's 50 accounts; remove one first.");
    await db().prepare('INSERT INTO sim_fh_arcade_accounts (username, name, start_balance, balance) VALUES (?, ?, ?, ?)').run(u.username, name, bal, bal);
    return accounts(u.username);
  }
  if (key === 'POST delete-account') {
    await account(u.username, args.account_id);
    await db().prepare('DELETE FROM sim_fh_arcade_accounts WHERE id = ? AND username = ?').run(Number(args.account_id), u.username);
    return accounts(u.username);
  }
  if (key === 'GET positions') return positions(u.username, args.account_id);
  if (key === 'POST open') {
    const a = await account(u.username, args.account_id), kind = String(args.kind ?? '');
    let side = String(args.side || 'long'), qty = Number(args.qty);
    if (side !== 'long' && side !== 'short') fail(400, 'Side must be long or short.');
    if (!(qty > 0)) fail(400, 'Quantity must be more than zero.');
    const sym = needSymbol(args.symbol);
    let price: number, reserved: number, label: string, expires: string, option: Json | null = null;
    if (kind === 'forex' || kind === 'stock') {
      if ((kind === 'forex') !== isForex(sym)) fail(400, `${sym} is not a ${kind} instrument.`);
      expires = String(args.expires ?? '');
      const d = dayOf(expires);
      if (!(d > today() && d <= today() + 366)) fail(400, 'The expiration must be after today and within a year.');
      price = spot(sym).price;
      if (kind === 'forex') { reserved = (FOREX[sym][1] === 'USD' ? qty : qty * price) / FX_LEVERAGE; label = FOREX[sym][0]; }
      else { qty = Math.floor(qty); if (qty < 1) fail(400, 'Trade at least one share.'); reserved = qty * price * (side === 'long' ? 1 : SHORT_MARGIN); label = sym; }
    } else if (kind === 'option') {
      if (isForex(sym)) fail(400, 'Options are for stocks.');
      side = 'long';
      const right = String(args.right ?? '');
      if (right !== 'call' && right !== 'put') fail(400, 'Choose a call or a put.');
      expires = String(args.expiration ?? '');
      const strike = Number(args.strike);
      if (!Number.isFinite(strike)) fail(400, 'Choose a strike.');
      const row = contract(sym, expires, right, strike);
      qty = Math.floor(qty);
      if (qty < 1) fail(400, 'Buy at least one contract.');
      price = row.ask; reserved = price * MULTIPLIER * qty; label = `${sym} ${expires} ${strike} ${right}`;
      option = { right, strike, contract: row.contractSymbol };
    } else return fail(400, 'Kind must be forex, stock or option.');
    if (reserved > a.balance + 1e-9) {
      fail(400, `Not enough cash: this needs $${round(reserved).toLocaleString('en-US')} and the account has $${round(a.balance).toLocaleString('en-US')} free.`);
    }
    await db().prepare('UPDATE sim_fh_arcade_accounts SET balance = balance - ? WHERE id = ?').run(reserved, a.id);
    await db().prepare(`INSERT INTO sim_fh_arcade_positions (account_id, kind, symbol, label, side, qty, open_price, expires, reserved, option)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(a.id, kind, sym, label, side, qty, price, expires, reserved, option ? JSON.stringify(option) : null);
    return positions(u.username, a.id);
  }
  if (key === 'POST close') {
    const p = await db().prepare(`SELECT p.* FROM sim_fh_arcade_positions p JOIN sim_fh_arcade_accounts a ON a.id = p.account_id
      WHERE p.id = ? AND a.username = ? AND p.status = 'open'`).get(Number(args.position_id) || 0, u.username) as Position | undefined;
    if (!p) return fail(404, 'No open position with that id.');
    const exit = p.kind === 'option' ? contract(p.symbol, dateOnly(p.expires), opt(p).right, opt(p).strike).bid : spot(p.symbol).price;
    await settle(p, exit, 'closed');
    return positions(u.username, p.account_id);
  }
  return fail(404, 'Not found.');
}

// ── trader ──
interface Prediction { id: number; ticker: string; ref_price: number; targets: { price: number; hit_at: string | null }[] | string;
  note: string | null; locked_at: string | Date; until_date: string | Date; cash: number | null; cash_rate: number | null;
  cash_source: string | null; status: string; loss: number | null }
const targetsOf = (p: Prediction) => (typeof p.targets === 'string' ? JSON.parse(p.targets) : p.targets) as { price: number; hit_at: string | null }[];

async function profileOf(username: string) {
  const row = await db().prepare('SELECT settings, secrets_set FROM sim_fh_trader_profiles WHERE username = ?').get(username) as
    { settings: Json | string; secrets_set: Json | string } | undefined;
  const parse = (v: Json | string | undefined) => (typeof v === 'string' ? JSON.parse(v) : v ?? {}) as Json;
  return { settings: { broker: 'none', cash_rate_fallback: null, ...parse(row?.settings) } as Json, set: parse(row?.secrets_set) };
}
async function scorePredictions(username: string) {
  const open = await db().prepare("SELECT * FROM sim_fh_predictions WHERE username = ? AND status = 'open'").all(username) as Prediction[];
  for (const p of open) {
    const start = dayOf(dateOnly(p.locked_at)), until = dayOf(dateOnly(p.until_date)), end = Math.min(until, today());
    const targets = targetsOf(p);
    for (const t of targets) {
      if (t.hit_at) continue;
      const up = t.price >= p.ref_price;
      for (let d = start; d <= end; d++) {
        const b = bar(p.ticker, d);
        if ((up && b.h >= t.price) || (!up && b.l <= t.price)) { t.hit_at = isoDay(d); break; }
      }
    }
    const hit = targets.filter(t => t.hit_at).length, done = today() > until || hit === targets.length;
    let status = 'open', loss: number | null = null;
    if (done) {
      const unhit = targets.length - hit;
      status = !unhit ? 'realized' : !hit ? 'unhit' : 'partial';
      if (unhit && p.cash != null && p.cash_rate != null) loss = round(p.cash * p.cash_rate * (until - start) / 365 * unhit / targets.length);
    }
    await db().prepare(`UPDATE sim_fh_predictions SET targets = ?, status = ?, loss = ?, resolved_at = CASE WHEN ? <> 'open' THEN now() ELSE NULL END
      WHERE id = ?`).run(JSON.stringify(targets), status, loss, status, p.id);
  }
}
async function predictionList(username: string) {
  const rows = await db().prepare('SELECT * FROM sim_fh_predictions WHERE username = ? ORDER BY locked_at DESC LIMIT 500').all(username) as Prediction[];
  return rows.map(p => {
    const targets = targetsOf(p), days = dayOf(dateOnly(p.until_date)) - dayOf(dateOnly(p.locked_at)), resolved = p.status !== 'open';
    const parts = targets.map(t => (t.hit_at ? Math.abs(t.price - p.ref_price) / p.ref_price * 100 : resolved ? -(p.cash_rate ?? 0) * days / 365 * 100 : 0));
    return { id: p.id, ticker: p.ticker, refPrice: p.ref_price, targets, note: p.note, lockedAt: iso(p.locked_at), until: dateOnly(p.until_date),
      cash: p.cash, cashRate: p.cash_rate, cashSource: p.cash_source, status: p.status, loss: p.loss, unhit: targets.filter(t => !t.hit_at).length,
      returnPct: parts.length ? round(parts.reduce((a, b) => a + b, 0) / parts.length, 3) : 0, missingCashRate: p.cash_rate == null };
  });
}
async function predictionsView(username: string) {
  await scorePredictions(username);
  const rows = await predictionList(username), done = rows.filter(r => r.status !== 'open');
  return { predictions: rows, summary: { open: rows.length - done.length, scored: done.length,
    realized: done.filter(r => r.status === 'realized').length, partial: done.filter(r => r.status === 'partial').length,
    unhit: done.filter(r => r.status === 'unhit').length, loss: round(done.reduce((s, r) => s + (r.loss ?? 0), 0)),
    returnPctTotal: round(rows.reduce((s, r) => s + r.returnPct, 0), 3), returnPctScored: round(done.reduce((s, r) => s + r.returnPct, 0), 3) } };
}

// Sample FUll SCAN sections, in the shape the Trader page reads (labelled as sample data; the real ones are private).
const COMPANIES: [string, string, string, string][] = [   // ticker, name, sector, sector ETF
  ['AAPL', 'Apple', 'Technology', 'XLK'], ['MSFT', 'Microsoft', 'Technology', 'XLK'], ['NVDA', 'NVIDIA', 'Technology', 'XLK'],
  ['AMZN', 'Amazon', 'Consumer Discretionary', 'XLY'], ['TSLA', 'Tesla', 'Consumer Discretionary', 'XLY'], ['HD', 'Home Depot', 'Consumer Discretionary', 'XLY'],
  ['JPM', 'JPMorgan Chase', 'Financials', 'XLF'], ['GS', 'Goldman Sachs', 'Financials', 'XLF'], ['XOM', 'Exxon Mobil', 'Energy', 'XLE'],
  ['CVX', 'Chevron', 'Energy', 'XLE'], ['UNH', 'UnitedHealth', 'Health Care', 'XLV'], ['LLY', 'Eli Lilly', 'Health Care', 'XLV'],
];
function fullScan(): Json {
  const t = today(), now = new Date().toISOString().slice(0, 19), month = isoDay(t).slice(0, 7), asOf = isoDay(t - 1);
  const r = (k: string) => (hash(k + month) % 1000) / 1000;
  const priced = COMPANIES.map(([tk, name, sector, etf], i) => ({ ticker: tk, name, sector, etf, price: spot(tk).price, i }));
  const records = priced.map(c => {
    const fair = c.price * (0.8 + 0.5 * r(c.ticker + 'f'));
    return { rank: 0, ticker: c.ticker, name: c.name, sector: c.sector, industry: c.sector, verdict: fair > c.price ? 'undervalued' : 'overvalued',
      price: c.price, est_median: round(fair), est_min: round(fair * 0.85), est_max: round(fair * 1.18), pe: round(12 + 30 * r(c.ticker + 'pe'), 1),
      pe_min: 10, pe_max: 45, roe: round(0.05 + 0.4 * r(c.ticker + 'roe'), 3), growth: round(0.25 * r(c.ticker + 'g'), 3),
      debt_ratio: round(0.6 * r(c.ticker + 'd'), 2), ev_ebitda: round(8 + 20 * r(c.ticker + 'ev'), 1), analyst_mean: round(c.price * 1.08),
      analyst_low: round(c.price * 0.85), analyst_high: round(c.price * 1.3), high_1y: round(c.price * 1.12), eps_ttm: round(c.price / 25),
      eps_forward: round(c.price / 22), peer_group: c.sector, dcf_value: round(fair * 0.95), price_to_book: round(2 + 10 * r(c.ticker + 'pb'), 1),
      peg: round(0.8 + 2 * r(c.ticker + 'peg'), 2), revenue_growth: round(0.2 * r(c.ticker + 'rg'), 3), quick_ratio: round(0.6 + r(c.ticker + 'q'), 2),
      current_ratio: round(0.9 + r(c.ticker + 'c'), 2), fetched_at: now };
  }).sort((a, b) => b.est_median / b.price - a.est_median / a.price).map((x, i) => ({ ...x, rank: i + 1 }));
  const TYPES = ['earnings', 'dividend', 'split', 'investor_day'];
  const events = priced.map((c, i) => ({ date: isoDay(t + 2 + ((i * 5) % 40)), ticker: c.ticker, type: TYPES[i % TYPES.length],
    status: 'expected', figure: i % 4 === 0 ? `EPS est ${round(c.price / 90)}` : '', summary: 'Sample event (simulated Services Hub)', url: null }));
  const upcoming = events.filter(e => dayOf(e.date) <= t + 14);
  const sectors: Record<string, { rows: Json[] }> = {};
  for (const c of priced) {
    (sectors[c.sector] ??= { rows: [] }).rows.push({ rank: sectors[c.sector].rows.length + 1, ticker: c.ticker, name: c.name, spot: c.price,
      total_oi: Math.round(200_000 + 3_000_000 * r(c.ticker + 'oi')), total_volume: Math.round(50_000 + 900_000 * r(c.ticker + 'v')),
      atm_spread: round(0.002 + 0.02 * r(c.ticker + 's'), 4), expirations: 18, market_cap: Math.round(c.price * 2e9 * (1 + 10 * r(c.ticker + 'mc'))) });
  }
  const groups = new Map<string, typeof priced>();
  for (const c of priced) groups.set(c.sector, [...(groups.get(c.sector) ?? []), c]);
  const bySector = [...groups].map(([sector, cs]) => ({ sector, etf: cs[0].etf,
    picks: cs.map((c, i) => ({ ticker: c.ticker, name: c.name, rank: i + 1, of: cs.length, price: c.price })) }));
  const months: Record<string, Json> = {};
  for (const m of [isoDay(t - 30).slice(0, 7), month]) {
    months[m] = { status: 'generated', long: bySector.filter((_, i) => i % 2 === 0), short: bySector.filter((_, i) => i % 2 === 1) };
  }
  const assets = bySector.flatMap((g, i) => g.picks.slice(0, 1).map(p => {
    const e = events.find(x => x.ticker === p.ticker);
    return { side: i % 2 === 0 ? 'long' : 'short', ticker: p.ticker, sector: g.sector, rank: p.rank, of: p.of, price: p.price,
      next_type: e?.type ?? '', next_date: e?.date ?? '', days_until: e ? dayOf(e.date) - t : null };
  }));
  return { workbook: 'trading', sample: true, sections: {
    dashboard: { run_time: now, month, assets, upcoming, crisis: { level: 'low', rows: [
      { indicator: 'Yield curve (10y-2y)', value: 0.42, percentile: 0.55, status: 'normal', asof: asOf },
      { indicator: 'High-yield spread', value: 3.1, percentile: 0.31, status: 'normal', asof: asOf },
      { indicator: 'VIX', value: 16.4, percentile: 0.38, status: 'normal', asof: asOf },
      { indicator: 'Unemployment rate', value: 4.1, percentile: 0.47, status: 'watch', asof: asOf }] } },
    rank: { as_of: asOf, records }, events: { as_of: asOf, events }, tickers: { as_of: asOf, sectors }, schedule: { months } } };
}

async function trader(route: string, method: string, args: Json, u: User): Promise<Json | { csv: string }> {
  const key = `${method} ${route}`;
  if (route === 'profile') {
    const p = await profileOf(u.username);
    if (method === 'POST') {
      if ('broker' in args) { if (!['none', 'webull'].includes(String(args.broker))) fail(400, 'broker must be webull or none.'); p.settings.broker = args.broker; }
      if ('cash_rate_fallback' in args) {
        const v = args.cash_rate_fallback;
        if (v === null || v === '') p.settings.cash_rate_fallback = null;
        else { let r = Number(v); if (!Number.isFinite(r)) fail(400, 'The cash rate must be a number, e.g. 4.1 for 4.1%.');
          r = round(r > 1 ? r / 100 : r, 6); if (r < 0 || r > 0.25) fail(400, 'The cash rate must be between 0% and 25%.'); p.settings.cash_rate_fallback = r; }
      }
      for (const f of ['calendar_url', 'webull_app_key', 'webull_app_secret']) if (f in args) p.set[f] = !!args[f];   // the simulation keeps no secrets
      await db().prepare(`INSERT INTO sim_fh_trader_profiles (username, settings, secrets_set) VALUES (?, ?, ?)
        ON CONFLICT (username) DO UPDATE SET settings = EXCLUDED.settings, secrets_set = EXCLUDED.secrets_set`)
        .run(u.username, JSON.stringify(p.settings), JSON.stringify(p.set));
    }
    return { settings: p.settings, set: { calendar_url: !!p.set.calendar_url, webull_app_key: !!p.set.webull_app_key,
      webull_app_secret: !!p.set.webull_app_secret }, role: u.role };
  }
  if (key === 'GET calendar') {
    const from = String(args.from || isoDay(today())), to = String(args.to || isoDay(today() + 42));
    const p = await profileOf(u.username), fs = fullScan().sections as { events: { events: { date: string; ticker: string; type: string; figure: string }[] } };
    return { from, to, mine: [], hasCalendar: !!p.set.calendar_url,
      mineError: p.set.calendar_url ? 'The simulated Services Hub does not read calendars.' : null,
      fullscan: fs.events.events.filter(e => e.date >= from && e.date <= to)
        .map(e => ({ date: e.date, title: `${e.ticker} ${e.type.replace('_', ' ')}`, detail: e.figure, kind: e.type, url: null })) };
  }
  if (route === 'settings') {
    if (u.role !== 'admin') fail(403, 'Scanner settings are admin only.');
    return { editable: true, changed: [], processes: [
      { group: 'Stock Scanner (sample)', title: 'Monthly long / short picks', note: 'Sample settings: the real scanner settings are private.',
        settings: [{ key: 'picks.per_sector', section: 'picks', name: 'Picks per sector', value: 3, type: 'int', editable: false, note: '' },
          { key: 'picks.min_market_cap', section: 'picks', name: 'Smallest market cap (billions)', value: 10, type: 'int', editable: false, note: '' }] },
      { group: 'Economy Scanner (sample)', title: 'Crisis level', settings: [
        { key: 'crisis.watch_percentile', section: 'crisis', name: 'Watch from percentile', value: 0.8, type: 'float', editable: false, note: '' }] }] };
  }
  if (key === 'GET predictions') return predictionsView(u.username);
  if (key === 'POST lock') {
    const ticker = needSymbol(args.ticker), until = String(args.until ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) fail(400, 'The locked date must be a date like 2026-12-31.');
    if (dayOf(until) <= today()) fail(400, 'The locked date must be in the future.');
    const raw = Array.isArray(args.targets) ? args.targets : String(args.targets ?? '').split(/[,\s]+/).filter(Boolean);
    const targets = raw.map(Number);
    if (!targets.length || targets.length > 10 || targets.some(x => !(x > 0))) fail(400, 'Give one to ten target prices.');
    const p = await profileOf(u.username), rate = p.settings.cash_rate_fallback as number | null;
    const r = await db().prepare(`INSERT INTO sim_fh_predictions (username, ticker, ref_price, targets, note, until_date, cash, cash_rate, cash_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(u.username, ticker, spot(ticker).price,
      JSON.stringify(targets.map(price => ({ price, hit_at: null }))), String(args.note ?? '').slice(0, 500) || null, until, null, rate,
      rate == null ? 'none' : 'none (cash rate from Settings)') as { id: number };
    return { id: r.id, predictions: await predictionList(u.username) };
  }
  if (key === 'POST delete') {
    const r = await db().prepare("DELETE FROM sim_fh_predictions WHERE id = ? AND username = ? AND status = 'open' RETURNING id")
      .get(Number(args.id) || 0, u.username);
    if (!r) fail(404, 'No open prediction with that id (scored predictions stay on the record).');
    return { predictions: await predictionList(u.username) };
  }
  if (key === 'GET export') {
    const { predictions: rows } = await predictionsView(u.username);
    const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Locked', 'Ticker', 'Price at lock', 'Targets', 'Hit', 'Locked until', 'Status', 'Return %', 'Cash at lock', 'Cash rate', 'Loss', 'Cash source', 'Note'];
    const lines = rows.map(r => [r.lockedAt.slice(0, 10), r.ticker, r.refPrice, r.targets.map(t => t.price).join(', '),
      r.targets.filter(t => t.hit_at).map(t => `${t.price} on ${t.hit_at}`).join(', '), r.until, r.status, r.returnPct, r.cash, r.cashRate, r.loss, r.cashSource, r.note]);
    return { csv: [head, ...lines].map(l => l.map(cell).join(',')).join('\r\n') };
  }
  return fail(404, 'Not found.');
}

// ── the API ──
/** Every route the simulated Services Hub answers (scripts/check-contract.mjs compares it with contract/hooks.json). */
export const SIM_SERVICES_ROUTES = [
  'GET /v1/status', 'GET /v1/tools', 'POST /v1/auth/login', 'POST /v1/auth/sso', 'GET /v1/me', 'POST /v1/auth/logout',
  'GET /v1/tools/arcade/banner', 'GET /v1/tools/arcade/quote', 'GET /v1/tools/arcade/options', 'GET /v1/tools/arcade/accounts',
  'POST /v1/tools/arcade/accounts', 'POST /v1/tools/arcade/delete-account', 'POST /v1/tools/arcade/open',
  'POST /v1/tools/arcade/close', 'GET /v1/tools/arcade/positions',
  'GET /v1/tools/trader/profile', 'POST /v1/tools/trader/profile', 'GET /v1/tools/trader/calendar', 'GET /v1/tools/trader/settings',
  'POST /v1/tools/trader/settings', 'GET /v1/tools/trader/predictions', 'POST /v1/tools/trader/lock', 'POST /v1/tools/trader/delete',
  'GET /v1/tools/trader/export', 'GET /v1/tools/full-scan/data',
];
const TOOLS = [
  { id: 'arcade', title: 'Arcade', description: 'Practice accounts: trade forex, stocks and options at live prices and keep score.' },
  { id: 'trader', title: 'Trader', description: "Your trading desk: the Stock and Economy Scanners, your calendar next to the Stock Scanner's, and locked predictions." },
  { id: 'full-scan', title: 'FUll SCAN', description: 'Macro, seasonal and trading data (sample data in the simulation).' },
];

/** One /v1 request: { status, body } as JSON, or a CSV download for the predictions export. */
export async function handle(method: string, path: string, query: URLSearchParams, body: Json, auth: string | null,
  appOrigin: string): Promise<{ status: number; json?: unknown; csv?: string }> {
  await setup();
  const args: Json = method === 'GET' ? Object.fromEntries(query) : body;
  if (path === '/v1/status') {
    return { status: 200, json: { ok: true, version: 'sim', provider: 'simulated', dataDelay: 'simulated prices (npm run sim)',
      ssoUrl: appOrigin, passwordLoginUntil: null } };
  }
  if (path === '/v1/tools') {
    return { status: 200, json: { tools: TOOLS.map(t => ({ ...t, routes: SIM_SERVICES_ROUTES
      .filter(r => r.includes(`/v1/tools/${t.id}/`)).map(r => { const [m, p] = r.split(' '); return `${m} ${p.split('/').pop()}`; }) })) } };
  }
  if (method === 'POST' && path === '/v1/auth/login') {
    const u = await getUserByLogin(String(body.email ?? ''));
    if (!u || !u.active || !u.password_hash || !verifyPassword(String(body.password ?? ''), u.password_hash)) fail(401, 'Wrong email or password.');
    return { status: 200, json: await issue({ username: u!.username, email: u!.username_email, role: u!.role === 'admin' ? 'admin' : 'user' }) };
  }
  if (method === 'POST' && path === '/v1/auth/sso') {
    const p = verifyPass('fusionhub', String(body.pass ?? ''));
    if (!p) fail(400, 'That sign-in link is not valid or has expired. Sign in again.');
    return { status: 200, json: await issue({ username: p!.username, email: p!.email, role: p!.role === 'admin' ? 'admin' : 'user' }) };
  }
  const u = await userFor(auth);
  if (method === 'GET' && path === '/v1/me') return { status: 200, json: { email: u.email, role: u.role, plan: 'sim' } };
  if (method === 'POST' && path === '/v1/auth/logout') {
    await db().prepare('DELETE FROM sim_fh_tokens WHERE token = ?').run(u.token);
    return { status: 200, json: { ok: true } };
  }
  const m = /^\/v1\/tools\/([a-z0-9-]+)\/([a-z0-9-]+)$/.exec(path);
  if (m?.[1] === 'arcade') return { status: 200, json: await arcade(m[2], method, args, u) };
  if (m?.[1] === 'trader') {
    const out = await trader(m[2], method, args, u);
    return 'csv' in out ? { status: 200, csv: out.csv as string } : { status: 200, json: out };
  }
  if (m?.[1] === 'full-scan' && m[2] === 'data') return { status: 200, json: fullScan() };
  return fail(404, 'Not found.');
}
