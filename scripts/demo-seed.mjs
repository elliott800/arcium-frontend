// Demo seeder: fills the demo database with simulated systems for the demo
// site (ARCIUM_SITE_MODE=demo). Never point it at the live database; it refuses
// any database whose name doesn't contain "demo".
//
//   node scripts/demo-seed.mjs <demo database url> [--seed N] [--systems N]
//
// Everything is written for the template user `demo_template`. Each demo test
// session gets its own copy of those rows (src/lib/demo.ts), so visitors can
// change things without affecting each other, and the copy is deleted when
// the session ends.
//
// The catalog is 75% good systems and 25% bad ones. Bad systems look fine
// in-sample and fall apart out-of-sample, the way overfit systems do. Equity
// character follows the model kind:
//   clf_bag    classifier systems: several sub-signals, each mostly flat with
//              short spikes when it fires, summed and normalized
//   alpha_bag  GA pipeline outputs: gradual, traditional-looking curves
//   mix        a classifier side and a GA side summed and normalized
//   time_mix   the same two sides, switching between them over time
// Every statistic in the catalog is measured from that system's own curve.
// Silo equity curves are the normalized sum of the systems the silo uses.
import pg from 'pg';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const TEMPLATE_USER = 'demo_template';

/** Writes the simulated systems for `demo_template` through `client` (anything with node-postgres's `query`). */
export async function seedDemo(client, { seed = 20261018, systems: nSystems = 80, label = 'the demo database' } = {}) {
  const MACHINE = 'demo_machine';
  const N_SYSTEMS = nSystems;
  const GOOD_SHARE = 0.75;

  // ── deterministic randomness ────────────────────────────────────────────────
  let state = (seed >>> 0) || 1;
  function rand() {                                  // mulberry32
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const uniform = (a, b) => a + (b - a) * rand();
  const int = (a, b) => Math.floor(uniform(a, b + 1));
  const pick = arr => arr[Math.floor(rand() * arr.length)];
  function normal() {
    let u = 0;
    while (u === 0) u = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  }
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr;
  }
  const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

  // ── universe ────────────────────────────────────────────────────────────────
  const SILOS = ['mean_reversion', 'trend_follower', 'momentum_breakout', 'carry_rotation'];
  const RATES = ['M30', 'H1', 'D'];
  const KINDS = ['clf_bag', 'alpha_bag', 'mix', 'time_mix'];
  const INSTRUMENTS = ['EUR_USD', 'GBP_USD', 'USD_JPY', 'AUD_USD', 'USD_CAD', 'USD_CHF', 'NZD_USD',
    'EUR_JPY', 'GBP_JPY', 'AUD_JPY', 'EUR_GBP', 'EUR_AUD', 'CHF_JPY', 'CAD_JPY'];
  // Bars per year and bars of history per rate.
  const PER_YEAR = { M30: 48 * 252, H1: 24 * 252, D: 252 };
  const BARS = { M30: 12096 * 5, H1: 6048 * 6, D: 252 * 10 };   // 5-10 years each, so measured Sharpe is stable
  const BAR_MS = { M30: 30 * 60e3, H1: 60 * 60e3, D: 24 * 3600e3 };
  const IS_FRAC = 0.7;

  // ── equity character by kind ────────────────────────────────────────────────
  // Classifier: k sub-signals, each flat most of the time and firing short
  // spikes. The per-spike edge is set from how often the signals fire, so the
  // annualized Sharpe lands on the target in- and out-of-sample.
  function classifierReturns(T, perYear, srIns, srOos) {
    const r = new Float64Array(T);
    const k = int(3, 6);
    const split = Math.floor(T * IS_FRAC);
    const subs = [...Array(k)].map(() => ({ p: uniform(0.004, 0.02), hold: int(1, 4) }));
    const perYearEvents = subs.reduce((a, s) => a + s.p * perYear / (1 + s.p * s.hold), 0);
    const edgeIns = srIns / Math.sqrt(perYearEvents), edgeOos = srOos / Math.sqrt(perYearEvents);
    for (const { p, hold } of subs) {
      for (let t = 0; t < T; t++) {
        if (rand() >= p) continue;
        const move = (t < split ? edgeIns : edgeOos) + normal();
        for (let h = 0; h < hold && t + h < T; h++) r[t + h] += move / hold;
        t += hold;
      }
    }
    return r;
  }

  // GA: a steady drift under noise; a mild slow wobble keeps it from looking synthetic.
  function gaReturns(T, perYear, srIns, srOos) {
    const r = new Float64Array(T);
    const split = Math.floor(T * IS_FRAC);
    let wobble = 0;
    for (let t = 0; t < T; t++) {
      wobble = 0.995 * wobble + 0.1 * normal();
      const sr = t < split ? srIns : srOos;
      r[t] = sr / Math.sqrt(perYear) + normal() + 0.05 * wobble;
    }
    return r;
  }

  function normalize(r, perYear, annualVol = 0.12) {
    const n = r.length;
    let mean = 0; for (const v of r) mean += v; mean /= n;
    let sd = 0; for (const v of r) sd += (v - mean) ** 2; sd = Math.sqrt(sd / n) || 1;
    const scale = annualVol / Math.sqrt(perYear) / sd;
    return r.map(v => v * scale);
  }

  function systemReturns(kind, rate, good) {
    const T = BARS[rate], P = PER_YEAR[rate];
    // In-sample every system looks tradeable; out-of-sample only good ones hold up.
    const clf = () => {
      const ins = uniform(1.2, 2.2);
      return classifierReturns(T, P, ins, good ? ins * uniform(0.55, 0.9) : uniform(-0.8, 0.2));
    };
    const ga = () => {
      const ins = uniform(1.2, 2.2);
      return gaReturns(T, P, ins, good ? ins * uniform(0.55, 0.9) : uniform(-0.8, 0.2));
    };
    if (kind === 'clf_bag') return normalize(clf(), P);
    if (kind === 'alpha_bag') return normalize(ga(), P);
    const a = normalize(clf(), P), b = normalize(ga(), P);
    if (kind === 'mix') return normalize(a.map((v, i) => v + b[i]), P);
    // time_mix: regimes of a few hundred bars alternate between the two sides.
    const out = new Float64Array(T);
    let side = rand() < 0.5, left = int(150, 600);
    for (let t = 0; t < T; t++) {
      if (--left <= 0) { side = !side; left = int(150, 600); }
      out[t] = side ? a[t] : b[t];
    }
    return normalize(out, P);
  }

  // ── statistics measured from a return series ────────────────────────────────
  function sharpe(r, perYear) {
    const n = r.length;
    if (n < 2) return 0;
    let mean = 0; for (const v of r) mean += v; mean /= n;
    let sd = 0; for (const v of r) sd += (v - mean) ** 2; sd = Math.sqrt(sd / (n - 1));
    return sd > 0 ? (mean / sd) * Math.sqrt(perYear) : 0;
  }

  function segmentStats(r, perYear, rate) {
    const trades = [];
    let open = 0, inTrade = false;
    for (const v of r) {                             // a trade = a run of bars with exposure
      if (Math.abs(v) > 1e-12) { open += v; inTrade = true; }
      else if (inTrade) { trades.push(open); open = 0; inTrade = false; }
    }
    if (inTrade) trades.push(open);
    // GA systems are always exposed: count a trade every ~12 bars instead.
    if (trades.length < r.length / 50) {
      trades.length = 0;
      for (let i = 0; i < r.length; i += 12) trades.push(r.slice(i, i + 12).reduce((a, b) => a + b, 0));
    }
    const wins = trades.filter(x => x > 0), losses = trades.filter(x => x < 0);
    const grossWin = wins.reduce((a, b) => a + b, 0), grossLoss = -losses.reduce((a, b) => a + b, 0);
    let eq = 1, peak = 1, maxDd = 0;
    for (const v of r) {
      eq *= 1 + v; peak = Math.max(peak, eq);
      maxDd = Math.max(maxDd, 1 - eq / peak);
    }
    // Longest run of consecutive trades under the running peak (trade_stats.dd_tuw).
    let teq = 0, tpeak = 0, run = 0, tuw = 0;
    for (const x of trades) {
      teq += x;
      if (teq >= tpeak) { tpeak = teq; run = 0; } else tuw = Math.max(tuw, ++run);
    }
    const days = r.length * BAR_MS[rate] / (24 * 3600e3) * (5 / 7);
    const sr = sharpe(r, perYear);
    return {
      sr,
      n_trades: trades.length,
      accuracy: trades.length ? wins.length / trades.length : 0,
      profit_factor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 9.99 : 0,
      mean_trade_pnl: trades.length ? trades.reduce((a, b) => a + b, 0) / trades.length : 0,
      trades_per_day: days > 0 ? trades.length / days : 0,
      max_dd: maxDd,
      tuw,
      // confidence the true Sharpe is above zero, from the t-stat of the trades
      confidence: 1 / (1 + Math.exp(-sr * Math.sqrt(Math.max(trades.length, 1)) / 6)),
    };
  }

  function rollingSharpe(r, perYear, points = 24) {
    const win = Math.max(30, Math.floor(r.length / 2));
    const out = [];
    for (let i = 0; i < points; i++) {
      const end = Math.floor(win + (r.length - win) * (i / (points - 1)));
      out.push(round(sharpe(r.slice(end - win, end), perYear), 3));
    }
    return out;
  }

  // ── build the catalog ───────────────────────────────────────────────────────
  const nowMs = Date.now();
  const iso = ms => new Date(ms).toISOString();
  const NOW = iso(nowMs);
  const hex = s => createHash('sha256').update(s).digest('hex').slice(0, 24);

  function buildSystem(i, good) {
    const silo = SILOS[i % SILOS.length];
    const rate = pick(RATES), kind = pick(KINDS);
    const P = PER_YEAR[rate], T = BARS[rate];
    const instruments = shuffle([...INSTRUMENTS]).slice(0, int(1, 3));
    // Draw until the measured stats match the class: good holds up out-of-sample,
    // bad looks good in-sample only. Sampling noise alone would blur the split.
    let r, ins, oos;
    for (let attempt = 0; attempt < 60; attempt++) {
      r = systemReturns(kind, rate, good);
      const split = Math.floor(T * IS_FRAC);
      ins = segmentStats(r.slice(0, split), P, rate);
      oos = segmentStats(r.slice(split), P, rate);
      const ok = good
        ? ins.sr >= 0.8 && ins.sr <= 3 && oos.sr >= 0.6 && oos.sr <= 2.6
        : ins.sr >= 0.8 && ins.sr <= 3 && oos.sr >= -1.2 && oos.sr <= 0.3;
      if (ok) break;
    }
    const history = rollingSharpe(r.slice(Math.floor(T * IS_FRAC)), P);
    return {
      silo, rate, kind, good, instruments, returns: r, ins, oos, history,
      name: `${silo}_${kind}_${rate}_${i}`,
      use: good ? (rand() < 0.9 ? 1 : 0) : (rand() < 0.4 ? 1 : 0),
      insStart: iso(nowMs - T * BAR_MS[rate]),
      insEnd: iso(nowMs - Math.floor(T * (1 - IS_FRAC)) * BAR_MS[rate]),
    };
  }

  const nGood = Math.round(N_SYSTEMS * GOOD_SHARE);
  const classes = shuffle([...Array(N_SYSTEMS)].map((_, i) => i < nGood));
  const systems = classes.map((good, i) => buildSystem(i, good));
  const badSilo = 'carry_rotation';                  // one silo leans on more bad systems
  for (const s of systems) if (s.silo === badSilo && !s.good) s.use = 1;

  // ── silo equity: normalized sum of the systems each silo uses ───────────────
  const SIM_CYCLES = 2000, LIVE_CYCLES = 400, CYCLE_MS = 3600e3;
  function siloNav(silo, cycles, startBalance = 10000) {
    // Shape: the members' recent returns, each standardized, summed. Drift: the
    // members' average out-of-sample Sharpe, so a silo leaning on bad systems
    // goes nowhere even though its members' shapes look busy. (Members trade at
    // different rates, so their raw drift per bar can't be summed directly.)
    const members = systems.filter(s => s.silo === silo && s.use);
    const z = new Float64Array(cycles);
    for (const s of members) {
      const part = s.returns.slice(s.returns.length - cycles);
      const sd = Math.sqrt(part.reduce((a, v) => a + v * v, 0) / part.length) || 1;
      for (let t = 0; t < cycles; t++) z[t] += part[t] / sd;
    }
    const n = Math.max(members.length, 1);
    const mean = z.reduce((a, v) => a + v, 0) / cycles;
    const sdz = Math.sqrt(z.reduce((a, v) => a + (v - mean) ** 2, 0) / cycles) || 1;
    const targetSr = Math.max(-0.8, Math.min(2.5, members.reduce((a, s) => a + s.oos.sr, 0) / n * 1.2));
    const perCycleSd = 0.14 / Math.sqrt(6048);
    const r = [...z].map(v => ((v - mean) / sdz + targetSr / Math.sqrt(6048)) * perCycleSd);
    const nav = [];
    let eq = startBalance;
    for (const v of r) { eq *= 1 + v; nav.push(eq); }
    return nav;
  }

  function equityRows(silo, kind, nav) {
    // Balance moves when trades close (every few cycles); equity is marked to market.
    const rows = [];
    let balance = nav[0], margin = uniform(300, 700), next = int(3, 9);
    const start = nowMs - nav.length * CYCLE_MS;
    for (let t = 0; t < nav.length; t++) {
      let pnl = 0;
      if (--next <= 0) { pnl = nav[t] - balance; balance = nav[t]; next = int(3, 9); }
      margin = Math.max(50, margin + normal() * 20);
      rows.push({
        username: TEMPLATE_USER, trader_name: TEMPLATE_USER, silo_name: silo, engine_kind: kind,
        cycle_time: iso(start + t * CYCLE_MS), balance: round(balance, 2), equity: round(nav[t], 2),
        unrealised_pnl: round(nav[t] - balance, 2), margin_used: round(margin, 2), pnl: round(pnl, 2),
        ingest_ts: NOW, machine_name: MACHINE,
      });
    }
    return rows;
  }

  // ── write ───────────────────────────────────────────────────────────────────
  const need = ['catalog_signals', 'catalog_signal_stats', 'catalog_models', 'silo_registry', 'web_equity_curve', 'machines'];
  for (const t of need) {
    const r = await client.query('SELECT to_regclass($1) AS t', [`public.${t}`]);
    if (!r.rows[0].t) throw new Error(`table ${t} missing: start the site once against ${label} so it creates its schema, then re-run`);
  }

  async function insert(table, rows, chunk = 500) {
    if (!rows.length) return;
    const cols = Object.keys(rows[0]);
    for (let i = 0; i < rows.length; i += chunk) {
      const part = rows.slice(i, i + chunk);
      const values = [], params = [];
      part.forEach((row, ri) => {
        values.push(`(${cols.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(',')})`);
        for (const c of cols) params.push(row[c]);
      });
      await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values.join(',')}`, params);
    }
  }

  await client.query('BEGIN');
  const userTables = (await client.query(`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'username' AND table_name <> 'users'`)).rows.map(r => r.table_name);
  for (const t of userTables) await client.query(`DELETE FROM ${t} WHERE username = $1`, [TEMPLATE_USER]);
  await client.query('DELETE FROM machines WHERE machine_name = $1', [MACHINE]);

  await insert('machines', [{
    machine_name: MACHINE, hostname: 'sim-node-01', platform: 'linux', last_heartbeat: NOW, registered_at: NOW,
    capacity: 4, accepts_accounts: true,
    load_json: JSON.stringify({ at: Math.floor(nowMs / 1000), accounts: 0, cpu_percent: 37, stacks_running: SILOS.length }),
  }]);

  await insert('silo_registry', SILOS.map(silo => ({
    username: TEMPLATE_USER, silo_key: silo, person_name: TEMPLATE_USER, silo_name: silo, machine_name: MACHINE,
    status: 'active', has_stacks: 0, stack_rates: '[]', built_rates: '[]', last_synced: NOW,
    // Neutral settings only: the demo must not reveal how the real engine sizes risk
    // or how the optimizer is configured.
    trader_settings: JSON.stringify({
      person_name: TEMPLATE_USER, silo_name: silo.replace(/_/g, ' '), mode: 'simulated', data_rate: pick(RATES),
      account_currency: 'USD', watchlist: 'Majors', sim_balance: 10000, broker: 'simulated', timezone: 'America/New_York',
    }),
    optimizer_settings: JSON.stringify({}),
  })));

  await insert('catalog_signals', systems.map(s => ({
    username: TEMPLATE_USER, catalog_source: s.silo, signal_name: s.name, data_rate: s.rate, type: s.kind,
    instruments_json: JSON.stringify(s.instruments),
    oos_sr: round(s.oos.sr), ins_sr: round(s.ins.sr), oos_n_trades: s.oos.n_trades, ins_n_trades: s.ins.n_trades,
    oos_confidence_level: round(s.oos.confidence), ins_confidence_level: round(s.ins.confidence),
    tuw: s.oos.tuw, max_dd: round(s.oos.max_dd), use_flag: s.use, off_flag: s.use ? 0 : 1,
    blob_hash: hex(s.name), current_sharpe: s.history.at(-1), constructor_ref: null, synced_at: NOW,
    machine_name: MACHINE,
  })));

  await insert('catalog_signal_stats', systems.flatMap(s => s.instruments.map(inst => ({
    username: TEMPLATE_USER, machine_name: MACHINE, machine_id: null, catalog_source: s.silo, signal_name: s.name,
    instrument_name: inst, instruments: JSON.stringify(s.instruments), data_rate: s.rate, type: s.kind,
    created_at: s.insStart, run_time: round(uniform(20, 900), 1), deg_free_ratio: round(uniform(0.05, 0.4)),
    ins_sr: round(s.ins.sr), oos_sr: round(s.oos.sr), current_sharpe: s.history.at(-1), min_sharpe: Math.min(...s.history),
    oos_sharpe_history: JSON.stringify(s.history),
    ins_accuracy: round(s.ins.accuracy), oos_accuracy: round(s.oos.accuracy),
    ins_profit_factor: round(s.ins.profit_factor), oos_profit_factor: round(s.oos.profit_factor),
    tuw: s.oos.tuw, max_dd: round(s.oos.max_dd),
    ins_n_trades: s.ins.n_trades, oos_n_trades: s.oos.n_trades,
    ins_trades_per_day: round(s.ins.trades_per_day), oos_trades_per_day: round(s.oos.trades_per_day),
    ins_mean_trade_pnl: round(s.ins.mean_trade_pnl, 5), oos_mean_trade_pnl: round(s.oos.mean_trade_pnl, 5),
    ins_start: s.insStart, ins_end: s.insEnd, last_scored: NOW, ga_build_counter: int(1, 40),
    ins_confidence_level: round(s.ins.confidence), oos_confidence_level: round(s.oos.confidence),
    use_flag: s.use, off_flag: s.use ? 0 : 1,
    tags: JSON.stringify([s.kind === 'clf_bag' ? 'classifier' : s.kind === 'alpha_bag' ? 'ga' : 'mix']),
    blob_hash: hex(s.name), constructor_ref: null, synced_at: NOW,
  }))));

  // The component models behind each system: classifiers are scored on accuracy,
  // GA alpha models on Sharpe.
  const models = new Map();
  for (const s of systems) {
    for (let j = 0; j < int(1, 3); j++) {
      const clf = s.kind === 'clf_bag' || (s.kind !== 'alpha_bag' && j === 0);
      const row = {
        username: TEMPLATE_USER, catalog_source: s.silo,
        model_name: `${s.silo}_${clf ? 'clf' : 'alpha'}_${s.rate}_${s.name.split('_').at(-1)}_${j}`,
        model_type: clf ? 'classifier' : 'alpha_model', data_rate: s.rate, instrument_name: s.instruments[0],
        oos_sr: round(s.oos.sr * uniform(0.7, 1.1)),
        oos_accuracy: clf ? round(s.good ? uniform(0.53, 0.61) : uniform(0.46, 0.51)) : null,
        use_flag: s.use, off_flag: s.use ? 0 : 1, synced_at: NOW, machine_name: MACHINE,
      };
      models.set(`${row.catalog_source}|${row.model_name}|${row.model_type}`, row);
    }
  }
  await insert('catalog_models', [...models.values()]);

  const equity = [], navBlobs = [], portfolioBlobs = [], allocs = [], balances = [];
  for (const silo of SILOS) {
    const simNav = siloNav(silo, SIM_CYCLES);
    // Live trails the simulation slightly: a little slippage on every cycle.
    const liveNav = siloNav(silo, LIVE_CYCLES).map((v, i) => v * (1 - 0.00002 * i));
    for (const [kind, nav] of [['sim', simNav], ['live', liveNav]]) {
      equity.push(...equityRows(silo, kind, nav));
      const step = Math.max(1, Math.floor(nav.length / 300));
      navBlobs.push({
        username: TEMPLATE_USER, trader_name: TEMPLATE_USER, silo_name: silo, engine_kind: kind, machine_name: MACHINE,
        machine_id: null, synced_at: NOW, first_cycle: iso(nowMs - nav.length * CYCLE_MS), last_cycle: NOW,
        n_rows: nav.length,
        nav_data: JSON.stringify(nav.filter((_, i) => i % step === 0).map((v, i, a) => ({
          nav: round(v, 2), sample: kind === 'sim' && i < a.length * IS_FRAC ? 'ins' : 'oos',
        }))),
      });
      const insts = [...new Set(systems.filter(s => s.silo === silo && s.use).flatMap(s => s.instruments))].slice(0, 8);
      const w = insts.map(() => uniform(0.2, 1)); const wsum = w.reduce((a, b) => a + b, 0) || 1;
      // Open positions, as the engine's portfolio blob lists them.
      const positions = insts.map((inst, i) => {
        const price = inst.endsWith('JPY') ? uniform(95, 190) : uniform(0.6, 1.4);
        const units = Math.round(nav.at(-1) * 5 * (w[i] / wsum) / price / 100) * 100 * (rand() < 0.5 ? -1 : 1);
        const avg = price * (1 + normal() * 0.002);
        return {
          instrument: inst, side: units >= 0 ? 'long' : 'short', units, avg_price: round(avg, inst.endsWith('JPY') ? 3 : 5),
          last_price: round(price, inst.endsWith('JPY') ? 3 : 5), unrealised_pnl: round((price - avg) * units / (inst.endsWith('JPY') ? price : 1), 2),
          weight: round(w[i] / wsum),
        };
      });
      portfolioBlobs.push({
        username: TEMPLATE_USER, trader_name: TEMPLATE_USER, silo_name: silo, engine_kind: kind, machine_name: MACHINE,
        machine_id: null, synced_at: NOW, last_cycle: NOW, n_instruments: positions.length, portfolio_data: JSON.stringify(positions),
      });
      insts.forEach((inst, i) => allocs.push({
        username: TEMPLATE_USER, trader_name: TEMPLATE_USER, silo_name: silo, engine_kind: kind, instrument_name: inst,
        last_close_price: round(inst.endsWith('JPY') ? uniform(95, 190) : uniform(0.6, 1.4), 4),
        vol_weight: round(uniform(0.05, 0.3)), fitness_weight: round(uniform(0.05, 0.3)), tot_weight: round(w[i] / wsum),
        inventory: round(uniform(-5000, 5000), 0), ingest_ts: NOW, machine_name: MACHINE,
      }));
      balances.push({
        username: TEMPLATE_USER, trader_name: TEMPLATE_USER, silo_name: silo, engine_kind: kind,
        weight: round(1 / SILOS.length), max_allocation: 0.4, base_currency_allocation: round(nav.at(-1) / SILOS.length, 2),
        leveraged_base_currency: round(nav.at(-1) * 5 / SILOS.length, 2), margin_used: round(uniform(200, 900), 2),
        max_leverage: 20, ingest_ts: NOW, machine_name: MACHINE,
      });
    }
  }
  await insert('web_equity_curve', equity);
  await insert('nav_blob', navBlobs);
  await insert('portfolio_blob', portfolioBlobs);
  await insert('web_portfolio_allocs', allocs);
  await insert('web_balance_allocs', balances);

  await insert('watchlists', [
    { name: 'Majors', insts: 'EUR_USD,GBP_USD,USD_JPY,AUD_USD,USD_CAD,USD_CHF,NZD_USD' },
    { name: 'Yen Crosses', insts: 'USD_JPY,EUR_JPY,GBP_JPY,AUD_JPY,CHF_JPY,CAD_JPY' },
    { name: 'favorites', insts: 'EUR_USD,GBP_JPY,AUD_USD' },
  ].map(w => ({ username: TEMPLATE_USER, watchlist_name: w.name, instrument_names: w.insts, created_at: NOW })));

  await client.query('COMMIT');

  const good = systems.filter(s => s.good), bad = systems.filter(s => !s.good);
  const avg = (xs, f) => (xs.reduce((a, s) => a + f(s), 0) / xs.length).toFixed(2);
  console.log(`seeded ${label} for ${TEMPLATE_USER}: ${systems.length} systems (${good.length} good / ${bad.length} bad), `
    + `${models.size} models, ${equity.length} equity rows`);
  console.log(`  good: avg ins SR ${avg(good, s => s.ins.sr)}, oos SR ${avg(good, s => s.oos.sr)}`);
  console.log(`  bad:  avg ins SR ${avg(bad, s => s.ins.sr)}, oos SR ${avg(bad, s => s.oos.sr)}`);
  for (const k of KINDS) {
    const ks = systems.filter(s => s.kind === k);
    if (ks.length) console.log(`  ${k.padEnd(9)} ${ks.length} systems, oos trades/day ${avg(ks, s => s.oos.trades_per_day)}, tuw ${avg(ks, s => s.oos.tuw)}`);
  }
}

// ── command line ────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const url = args.find(a => !a.startsWith('--'));
  const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : dflt; };
  if (!url) {
    console.error('usage: node scripts/demo-seed.mjs <demo database url> [--seed N] [--systems N]');
    process.exit(2);
  }
  const dbName = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!/demo/.test(dbName)) throw new Error(`refusing: "${dbName}" doesn't look like a demo database (name must contain "demo")`);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try { await seedDemo(client, { seed: opt('seed', 20261018), systems: opt('systems', 80), label: dbName }); }
  finally { await client.end(); }
}
