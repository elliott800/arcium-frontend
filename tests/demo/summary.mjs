// Demo agent, step 3: pair the "before" (main) and "after" (pull request) recordings into one report.
//
//   node tests/demo/summary.mjs <out dir> [--pr 12 --sha abc123 --files changed.txt --gui tests/gui/out/report.json]
//
// Writes <out>/demo-report.json (what the Branch reviews utility reads) and prints a markdown summary (CI appends it
// to the job summary, so the pull request's checks page shows it too).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [outDir, ...rest] = process.argv.slice(2);
const opt = name => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : null; };
const read = p => (p && existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const before = read(join(outDir, 'before', 'report.json'));
const after = read(join(outDir, 'after', 'report.json'));
const gui = read(opt('gui'));
const files = opt('files') && existsSync(opt('files')) ? readFileSync(opt('files'), 'utf8').split(/\r?\n/).filter(Boolean) : [];

// ── pair the screens ──
const byId = r => new Map((r?.screens ?? []).map(s => [s.id, s]));
const b = byId(before), a = byId(after);
const screens = [...new Set([...a.keys(), ...b.keys()])].map(id => {
  const x = a.get(id), y = b.get(id);
  const newErrors = (x?.errors ?? []).filter(e => !(y?.errors ?? []).includes(e));
  return {
    id, file: x?.file ?? y?.file, url: x?.url ?? y?.url,
    after: x ? { status: x.status, loadMs: x.loadMs, errors: x.errors, phoneOverflow: x.phoneOverflow } : null,
    before: y ? { status: y.status, loadMs: y.loadMs, errors: y.errors, phoneOverflow: y.phoneOverflow } : null,
    newErrors,
    flags: [
      ...(x && x.status && x.status >= 400 ? [`HTTP ${x.status}`] : []),
      ...(newErrors.length ? [`${newErrors.length} new console error(s)`] : []),
      ...(x?.phoneOverflow && !y?.phoneOverflow ? ['phone layout now scrolls sideways'] : []),
      ...(x?.loadMs && y?.loadMs && x.loadMs > y.loadMs * 2 && x.loadMs - y.loadMs > 1500 ? [`slower: ${y.loadMs} → ${x.loadMs} ms`] : []),
      ...(!x ? ['not shown after the change'] : []),
    ],
  };
});
const guiFailed = gui ? (gui.results ?? gui).filter?.(r => r && r.ok === false).map(r => r.id) ?? [] : [];
const report = {
  pr: opt('pr'), sha: opt('sha'), at: new Date().toISOString(), files, screens,
  gui: gui ? { failed: guiFailed } : null,
  attention: screens.some(s => s.flags.length) || guiFailed.length > 0,
};
writeFileSync(join(outDir, 'demo-report.json'), JSON.stringify(report, null, 2));

// ── markdown for the checks page ──
const lines = [`### Demo agent: ${screens.length} screen(s) touched${report.attention ? ' — needs a look' : ''}`, ''];
if (!screens.length) lines.push('No screen is touched by this change (docs, tests or scripts only).');
else {
  lines.push('| Screen | Load (before → after) | Notes |', '|---|---|---|');
  for (const s of screens) {
    const ms = `${s.before?.loadMs ?? '–'} → ${s.after?.loadMs ?? '–'} ms`;
    lines.push(`| \`${s.id}\` | ${ms} | ${s.flags.join('; ') || 'looks the same to the checks'} |`);
  }
}
if (gui) lines.push('', guiFailed.length ? `GUI suite: failing ${guiFailed.join(', ')}` : 'GUI suite: all features pass.');
lines.push('', 'Screenshots and videos: the `demo` artifact of this run, and the Branch reviews page.');
console.log(lines.join('\n'));
