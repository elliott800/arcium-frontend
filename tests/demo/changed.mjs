// Demo agent, step 1: which screens a change touches.
//
//   node tests/demo/changed.mjs <changed file> ...          prints the screen ids, one per line
//   git diff --name-only origin/main...HEAD | node tests/demo/changed.mjs -
//
// A screen is a workspace dashboard id from src/modules/registry.ts (shown at /w/<id>), or one of the public pages
// (public:signin, public:forgot-password, public:reset-password), or "workspace" (the /w home).
// How a file maps to screens:
//   - shell, kit, root layout, global config or dependencies   -> every screen
//   - a file a dashboard imports, directly or through others    -> that dashboard
//   - an API route (or a file it imports)                       -> the dashboards whose code calls that route
//   - a public page or src/app/_public                          -> the public pages
// Anything else (docs, tests, scripts) touches no screen.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const rel = p => relative(ROOT, p).replace(/\\/g, '/');

// ── what touches everything ──
const GLOBAL = [/^src\/shell\//, /^src\/ui\//, /^src\/app\/layout\.tsx$/, /^src\/app\/w\//, /^src\/proxy\.ts$/,
  /^src\/modules\/registry\.ts$/, /^package(-lock)?\.json$/, /^next\.config\.ts$/, /^tsconfig\.json$/];
const PUBLIC_SCREENS = ['public:signin', 'public:forgot-password', 'public:reset-password'];
const PUBLIC = [/^src\/app\/_public\//, /^src\/app\/page\.tsx$/, /^src\/app\/(forgot|reset)-password\//];

// ── the dashboards and their entry files (from the registry) ──
export function dashboards() {
  const reg = readFileSync(join(ROOT, 'src/modules/registry.ts'), 'utf8');
  const out = [];
  for (const m of reg.matchAll(/\{\s*id:\s*'([^']+)'[\s\S]*?\}/g)) {
    const load = m[0].match(/load:\s*\(\)\s*=>\s*import\('\.\/([^']+)'\)/);
    if (load) out.push({ id: m[1], entry: resolveFile(join(ROOT, 'src/modules', load[1])) });
  }
  return out;
}

// ── a small import graph over src/ ──
function resolveFile(base) {
  for (const ext of ['', '.tsx', '.ts', '/index.tsx', '/index.ts']) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return normalize(p);
  }
  return null;
}

function importsOf(file) {
  const src = readFileSync(file, 'utf8');
  const out = [];
  for (const m of src.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1] || m[2] || m[3];
    const base = spec.startsWith('@/') ? join(ROOT, 'src', spec.slice(2)) : spec.startsWith('.') ? join(dirname(file), spec) : null;
    const hit = base && resolveFile(base);
    // the registry imports every dashboard; a change to it is global already, so it never links two dashboards
    if (hit && !hit.endsWith(normalize('src/modules/registry.ts'))) out.push(hit);
  }
  return out;
}

const closureCache = new Map();
function closure(entry) {
  if (closureCache.has(entry)) return closureCache.get(entry);
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (!f || seen.has(f)) continue;
    seen.add(f);
    stack.push(...importsOf(f));
  }
  closureCache.set(entry, seen);
  return seen;
}

function routes() {
  const out = [];
  const walk = d => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'route.ts') {
        const url = '/' + rel(dirname(p)).replace(/^src\/app\//, '');
        out.push({ file: normalize(p), prefix: url.replace(/\/\[[^\]]+\].*$/, '') });   // up to the first [param]
      }
    }
  };
  walk(join(ROOT, 'src/app/api'));
  return out;
}

// ── changed files -> screens ──
export function screensFor(files) {
  const all = dashboards();
  const changed = files.map(f => f.trim().replace(/\\/g, '/')).filter(Boolean);
  if (changed.some(f => GLOBAL.some(re => re.test(f)))) return ['workspace', ...PUBLIC_SCREENS, ...all.map(d => d.id)];
  const abs = new Set(changed.map(f => normalize(join(ROOT, f))));
  const hit = new Set();
  if (changed.some(f => PUBLIC.some(re => re.test(f)))) PUBLIC_SCREENS.forEach(s => hit.add(s));

  // dashboards whose own code imports a changed file
  for (const d of all) if ([...closure(d.entry)].some(f => abs.has(f))) hit.add(d.id);

  // routes touched (the route file or anything it imports) -> dashboards that call them
  const touched = routes().filter(r => [...closure(r.file)].some(f => abs.has(f))).map(r => r.prefix);
  if (touched.length) {
    for (const d of all) {
      const text = [...closure(d.entry)].map(f => readFileSync(f, 'utf8')).join('\n');
      if (touched.some(p => text.includes(`'${p}`) || text.includes(`\`${p}`) || text.includes(`"${p}`))) hit.add(d.id);
    }
  }
  return [...hit];
}

// ── command line ──
if (process.argv[1] && normalize(process.argv[1]) === normalize(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const files = args[0] === '-' ? readFileSync(0, 'utf8').split(/\r?\n/) : args;
  for (const s of screensFor(files)) console.log(s);
}
