// The mock controller machine: stands in for arcium backend and talks to the site through the real hooks
// (contract/hooks.json, explained in contract/README.md), so the GUI can be built against a backend that behaves like
// the real one: heartbeats, synced tables, a live equity stream, commands picked up and acknowledged.
//
//   npm run sim                                    the site on its simulated database (another terminal)
//   npm run mock:machine                           then this: a controller signing in as demo_machine
//   npm run mock:machine -- --once                 one round of every hook, a PASS/FAIL line each (exit 1 on a failure)
//   npm run mock:machine -- --user tester_ab12cd   stream into a test session's workspace instead (default:
//                                                  demo_template, which new test sessions copy, and admin, the
//                                                  simulated owner, whose workspace shows the stream live)
//   options: --site http://localhost:3010  --machine demo_machine  --key sim-machine-key  --cycle 10 (seconds)
//
// What it does, the way the backend does it:
//   POST /api/machine/sync            every cycle: heartbeat (host, platform, load), the processes snapshot, and the
//                                     `mock_live` silo's next equity row (its silo_registry row on the first push)
//   GET  /api/machine/commands        every 2 s: the command queue the GUI fills (engine start/stop, scripts, ...)
//   POST /api/machine/commands/{id}/ack   each command: running, then completed with a simulated output
//   GET  /api/machine/assignments     every 30 s: accounts placed on this machine; provisioning ones are reported ready
//   POST /api/machine/live-status     every 15 s and after each command: the launcher's status (the Live controller
//                                     panel's Pause, Train, engine start/stop buttons change what it reports)
//   GET  /api/machine/warehouse/catalog, /read   once at start: what the Data Hub records, and one series
//
// It only talks to a site on this computer (localhost / 127.0.0.1): it is a development tool, and the simulated
// machine's key opens nothing else. State (the mock silo's curve) is kept in the simulated database's folder (mock-machine.json), so
// `npm run sim -- --reset` starts it over too.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import path from 'node:path';
import { simDir } from './sim-dir.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const SITE = opt('site', 'http://localhost:3010').replace(/\/+$/, '');
const MACHINE = opt('machine', 'demo_machine');
const KEY = opt('key', 'sim-machine-key');
const USERS = opt('user', 'demo_template,admin').split(',').map(u => u.trim()).filter(Boolean);
const USER = USERS[0];
const CYCLE_S = Math.max(2, Number(opt('cycle', '10')) || 10);
const ONCE = args.includes('--once');
const SILO = 'mock_live';
const STATE_FILE = path.join(simDir(), 'mock-machine.json');

const host = new URL(SITE).hostname;
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error(`[mock] refusing ${SITE}: the mock machine only talks to a site on this computer.`);
  process.exit(2);
}

const API = `${SITE}/api`;
const AUTH = { 'x-machine-name': MACHINE, 'x-machine-key': KEY };
const now = () => new Date().toISOString();
const log = (...m) => console.log(`[mock ${new Date().toTimeString().slice(0, 8)}]`, ...m);

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...AUTH, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json?.error ?? text.slice(0, 200)}`);
  return json;
}

// ── state: the mock silo's equity curve ──
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return { balance: 10000, equity: 10000, cycles: 0, registered: false }; }
}
function saveState(s) {
  if (!existsSync(simDir())) mkdirSync(simDir(), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
}
const state = loadState();
const startedAt = now();
const startedMs = Date.now();
const commandLog = [];
// What the launcher is doing; the Live controller panel's buttons change it (controller/scripts/live_control.py).
const launcher = { paused: false, engineRunning: true, training: {} };

function nextEquityRows() {
  // A small drift and noise per cycle; a trade closes every few cycles and moves the balance to the equity.
  const step = state.equity * (0.0004 + (Math.random() - 0.5) * 0.006);
  state.equity = Math.round((state.equity + step) * 100) / 100;
  state.cycles += 1;
  let pnl = 0;
  if (state.cycles % 5 === 0) { pnl = Math.round((state.equity - state.balance) * 100) / 100; state.balance = state.equity; }
  const cycle = now(), margin = Math.round(300 + Math.random() * 200);
  return USERS.map(u => ({
    username: u, trader_name: u, silo_name: SILO, engine_kind: 'live', cycle_time: cycle,
    balance: state.balance, equity: state.equity, unrealised_pnl: Math.round((state.equity - state.balance) * 100) / 100,
    margin_used: margin, pnl, ingest_ts: now(), machine_name: MACHINE,
  }));
}

function siloRows() {
  return USERS.map(USER => ({
    username: USER, silo_key: SILO, person_name: USER, silo_name: SILO, machine_name: MACHINE,
    status: 'active', has_stacks: 0, stack_rates: '[]', built_rates: '[]', last_synced: now(),
    trader_settings: JSON.stringify({
      person_name: USER, silo_name: 'mock live', mode: 'simulated', data_rate: 'H1', account_currency: 'USD',
      watchlist: 'Majors', sim_balance: 10000, broker: 'simulated', timezone: 'America/New_York',
    }),
    optimizer_settings: JSON.stringify({}),
  }));
}

const processes = () => [
  { machine_name: MACHINE, username: null, process_name: 'machine_heartbeat', pid: 4100, status: 'running',
    started_at: startedAt, stopped_at: null, cmdline_summary: 'controller/scripts/machine_heartbeat.py --mock' },
  ...(launcher.engineRunning && !launcher.paused ? [{ machine_name: MACHINE, username: USER, process_name: `engine:${SILO}`,
    pid: 4101, status: 'running', started_at: startedAt, stopped_at: null, cmdline_summary: `arcium.py hangar run ${SILO} --mock` }] : []),
  ...Object.entries(launcher.training).map(([silo, pid]) => ({ machine_name: MACHINE, username: USER,
    process_name: `train:${silo}`, pid, status: 'running', started_at: now(), stopped_at: null,
    cmdline_summary: `arcium.py optimize ${silo} --mock` })),
];

/** The launcher's side of a live_control.py command from the Live controller panel. */
function applyLiveControl(flags) {
  const silo = flags.silo || SILO;
  switch (flags.action) {
    case 'pause': launcher.paused = true; return 'paused: engines and training hold';
    case 'resume': launcher.paused = false; return 'resumed';
    case 'train': launcher.training[silo] = 6000 + Math.floor(Math.random() * 900); return `training ${silo} (pid ${launcher.training[silo]})`;
    case 'untrain': delete launcher.training[silo]; return `stopped training ${silo}`;
    case 'engine_start': launcher.engineRunning = true; return `engine ${silo} started`;
    case 'engine_stop': launcher.engineRunning = false; return `engine ${silo} stopped`;
    case 'restart': return 'heartbeat restarted';
    case 'update': return 'already up to date (mock)';
    default: return 'status reported';
  }
}

// ── the hooks ──
async function sync() {
  const streaming = launcher.engineRunning && !launcher.paused;
  const tables = { processes: processes(), ...(streaming ? { web_equity_curve: nextEquityRows() } : {}) };
  if (state.registeredFor !== USERS.join(',')) tables.silo_registry = siloRows();
  const r = await call('POST', '/machine/sync', {
    machine_name: MACHINE, api_key: KEY,
    heartbeat: { hostname: `mock-${osHostname()}`.slice(0, 60), platform: process.platform,
      load: { at: Math.floor(Date.now() / 1000), accounts: 0, cpu_percent: Math.round(20 + Math.random() * 40), stacks_running: 1 } },
    tables,
  });
  const skipped = Object.entries(r.results).filter(([, v]) => typeof v === 'string');
  if (skipped.length) throw new Error(`sync skipped ${skipped.map(([t, v]) => `${t}: ${v}`).join('; ')}`);
  state.registeredFor = USERS.join(',');
  saveState(state);
  return streaming ? `equity ${state.equity.toFixed(2)} (cycle ${state.cycles}), tables ${JSON.stringify(r.results)}`
    : `heartbeat only (engine ${launcher.paused ? 'paused' : 'stopped'}), tables ${JSON.stringify(r.results)}`;
}

async function commands() {
  const { commands: queue } = await call('GET', '/machine/commands');
  for (const c of queue) {
    const flags = (() => { try { return JSON.parse(c.flags || '{}'); } catch { return {}; } })();
    log(`command ${c.id} from ${c.username ?? 'site'}: ${c.script_path} ${JSON.stringify(flags)}`);
    await call('POST', `/machine/commands/${c.id}/ack`, { machine_name: MACHINE, api_key: KEY, status: 'running', pid: 5000 + c.id });
    await new Promise(r => setTimeout(r, 1500));
    const live = c.script_path.endsWith('live_control.py');
    const result = live ? applyLiveControl(flags) : `would run ${c.script_path} with ${JSON.stringify(flags)}`;
    const output = `[mock machine] ${result} - simulated, nothing was executed.`;
    await call('POST', `/machine/commands/${c.id}/ack`, { machine_name: MACHINE, api_key: KEY, status: 'completed', output, exit_code: 0 });
    commandLog.push(`${now()} ${live ? flags.action : c.script_path}: ${result}`);
    log(`command ${c.id} completed: ${result}`);
  }
  if (queue.length) await liveStatus();          // the launcher reports at once after a command
  return `${queue.length} queued`;
}

async function assignments() {
  const { accounts } = await call('GET', '/machine/assignments');
  for (const a of accounts) {
    if (a.removed) await call('POST', '/machine/assignments', { account_id: a.id, status: 'removed' });
    else if (a.status === 'provisioning' || a.status === 'pending') {
      await call('POST', '/machine/assignments', { account_id: a.id, status: 'ready', detail: 'provisioned by the mock machine' });
      log(`account ${a.name ?? a.id} (${a.owner_username}) reported ready`);
    }
  }
  return `${accounts.length} account(s)`;
}

async function liveStatus() {
  // The shape the launcher sends (LiveStatus in src/legacy/control/LiveControllerPanel.tsx).
  await call('POST', '/machine/live-status', {
    commit: 'mock', paused: launcher.paused, processes: processes().length,
    up_seconds: Math.round((Date.now() - startedMs) / 1000), heartbeat_pid: 4100,
    silos: [SILO], training: launcher.training,
    train_logs: Object.fromEntries(Object.keys(launcher.training).map(s => [s, [`${now()} generation 1 (mock)`]])),
    launcher_log: [`${startedAt} mock machine started`, ...commandLog.slice(-10)],
  });
  return 'reported';
}

async function warehouse() {
  const { hooks } = await call('GET', '/machine/warehouse/catalog?limit=20');
  const series = hooks.flatMap(h => h.series ?? []);
  if (!series.length) return `${hooks.length} hooks, no series`;
  const s = series[0];
  const read = await call('GET', `/machine/warehouse/read?series_id=${s.series_id}&limit=5`);
  return `${hooks.length} hooks, ${series.length} series; read series ${s.series_id}: ${read.rows?.length ?? 0} rows`;
}

// ── run ──
async function attempt(name, fn) {
  try { const msg = await fn(); return { name, ok: true, msg }; }
  catch (e) { return { name, ok: false, msg: e instanceof Error ? e.message : String(e) }; }
}

async function once() {
  const results = [];
  for (const [name, fn] of [['sync', sync], ['commands + ack', commands], ['assignments', assignments],
    ['live-status', liveStatus], ['warehouse catalog + read', warehouse]]) results.push(await attempt(name, fn));
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(26)} ${r.msg}`);
  const failed = results.filter(r => !r.ok).length;
  console.log(failed ? `\nmock machine: ${failed} hook(s) failed` : '\nmock machine: every hook answered');
  if (failed && results.some(r => /ECONNREFUSED|fetch failed/.test(r.msg))) console.log(`Is the site running? npm run sim  (then --site ${SITE})`);
  process.exit(failed ? 1 : 0);
}

async function forever() {
  log(`${MACHINE} -> ${SITE} as ${USERS.join(' + ')}; one cycle every ${CYCLE_S}s. Ctrl+C stops.`);
  const first = await attempt('warehouse', warehouse);
  log(`warehouse: ${first.msg}`);
  const every = (ms, name, fn) => {
    let busy = false;
    const tick = async () => {
      if (busy) return; busy = true;
      const r = await attempt(name, fn);
      if (!r.ok) log(`${name} failed: ${r.msg}`);
      else if (name === 'sync') log(`sync: ${r.msg}`);
      busy = false;
    };
    tick(); setInterval(tick, ms);
  };
  every(CYCLE_S * 1000, 'sync', sync);
  every(2000, 'commands', commands);
  every(30_000, 'assignments', assignments);
  every(15_000, 'live-status', liveStatus);
}

if (ONCE) await once(); else await forever();
