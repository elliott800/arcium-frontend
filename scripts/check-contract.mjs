// The frontend half of the hooks contract check: proves this repo still serves everything contract/hooks.json says
// other services rely on, and reads no environment setting the contract does not list.
//
//     npm run contract          exits 1 and lists what broke
//
// Checks: every backend route (src/app/api/<path>/route.ts exporting each method), every site route, page and static
// file other services reach, and every process.env.X read under src/ and in next.config.ts. The owner's private
// production repo holds the same contract and also checks the backend side; change a hook there and here together.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const contract = JSON.parse(readFileSync(join(ROOT, 'contract', 'hooks.json'), 'utf8'));
const API = join(ROOT, 'src', 'app', 'api');
const fails = [];

function routeMethods(path) {
  let dir = API;
  for (const part of path.split('/').filter(Boolean)) {
    if (part.startsWith('{')) {
      const dyn = existsSync(dir) ? readdirSync(dir).filter(x => x.startsWith('[')) : [];
      if (!dyn.length) return null;
      dir = join(dir, dyn[0]);
    } else dir = join(dir, part);
  }
  const file = join(dir, 'route.ts');
  if (!existsSync(file)) return null;
  const src = readFileSync(file, 'utf8');
  return new Set([...src.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map(m => m[1]));
}

for (const r of contract.routes) {
  const got = routeMethods(r.path);
  if (!got) fails.push(`no route for ${r.path} (${r.caller}: ${r.what})`);
  else for (const m of r.methods) if (!got.has(m)) fails.push(`${r.path} does not export ${m} (serves ${[...got].join(', ') || 'nothing'})`);
}

const site = contract.site_routes ?? {};
for (const r of site.routes ?? []) {
  if (!routeMethods(r.path.replace(/^\/api/, ''))) fails.push(`no route for ${r.path} (used by ${r.caller})`);
}
for (const pg of site.pages ?? []) {
  if (!existsSync(join(ROOT, 'src', 'app', ...pg.split('/').filter(Boolean), 'page.tsx'))) fails.push(`no page ${pg}`);
}
for (const f of site.static ?? []) {
  if (!existsSync(join(ROOT, 'public', f.replace(/^\//, '')))) fails.push(`no static file ${f}`);
}

// The Services Hub API: the simulated one (src/lib/sim-services.ts SIM_SERVICES_ROUTES) answers every route listed, and
// the pages that call it are here (public/services/).
const services = contract.services_api?.routes ?? [];
if (services.length) {
  const src = readFileSync(join(ROOT, 'src', 'lib', 'sim-services.ts'), 'utf8');
  const listedSim = new Set([...(src.match(/SIM_SERVICES_ROUTES = \[([\s\S]*?)\];/)?.[1] ?? '').matchAll(/'([A-Z]+ \/v1\/[^']+)'/g)].map(m => m[1]));
  for (const r of services) for (const m of r.methods) {
    if (!listedSim.has(`${m} ${r.path}`)) fails.push(`the simulated Services Hub does not answer ${m} ${r.path} (src/lib/sim-services.ts)`);
  }
  for (const f of ['index.html', 'trader.html', 'arcade.html', 'arcium-sso.js', 'nav-loader.js']) {
    if (!existsSync(join(ROOT, 'public', 'services', f))) fails.push(`no Services Hub page public/services/${f}`);
  }
}

const listed = new Set([...contract.frontend_env.hooks, ...contract.frontend_env.site_only]);
const read = new Set();
const scan = file => { for (const m of readFileSync(file, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) read.add(m[1]); };
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|mjs|js)$/.test(e)) scan(p);
  }
})(join(ROOT, 'src'));
if (existsSync(join(ROOT, 'next.config.ts'))) scan(join(ROOT, 'next.config.ts'));
for (const v of [...read].filter(v => !listed.has(v)).sort()) fails.push(`reads environment setting ${v}, not in the contract`);

console.log(`contract: ${contract.routes.length} backend routes, ${(site.routes ?? []).length} site routes, ` +
  `${(site.pages ?? []).length} pages, ${services.length} Services Hub routes, ${read.size} environment settings checked`);
if (fails.length) {
  console.error(`contract: FAIL\n${fails.map(f => ' - ' + f).join('\n')}`);
  process.exit(1);
}
console.log('contract: PASS');
