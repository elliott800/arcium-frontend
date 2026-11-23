// Runs the site on the simulated backend: no database server, Data Hub or controller needed.
//
//   npm run sim                 start on http://localhost:3010 (first start builds .sim-db/, about a minute)
//   npm run sim -- --reset      throw the simulated database and build cache away and start fresh
//   npm run sim -- --port 3020  another port
//
// Sign in with "Start a test session", or as the simulated owner: admin@example.com / sim-admin-password.
// The Services Hub and the Arcade (public/services/, their /v1 API simulated by src/lib/sim-services.ts) answer on
// http://serviceshub.localhost:<port> and http://arcade.localhost:<port>; "Sign in with Arcium" works there.
// Everything lives in .sim-db/ (git-ignored); nothing here can reach a real database or machine.
import { rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { simDir } from './sim-dir.mjs';

const args = process.argv.slice(2);
const at = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const port = at('port') ?? '3010';
if (args.includes('--reset')) {        // the database and the build cache (a stale cache can 404 routes after a pull)
  for (const dir of [simDir(), '.next-sim']) rmSync(dir, { recursive: true, force: true });
  console.log(`[sim] ${simDir()} and .next-sim removed`);
}

const env = {
  ...process.env,
  DATABASE_URL: `sim:${simDir()}`,         // .sim-db/, or ARCIUM_SIM_DIR (scripts/sim-dir.mjs)
  ARCIUM_SITE_MODE: 'demo',
  // Local-only placeholders: the simulated database is made with these, so they are not secrets.
  ARCIUM_SECRET_KEY: '73696d2d6c6f63616c2d6f6e6c792d6b65792d6e6f742d612d7365637265742e',
  ARCIUM_ADMIN_EMAIL: 'admin@example.com',
  ARCIUM_ADMIN_PASSWORD: 'sim-admin-password',   // placeholder: opens only the local simulated database
  SITE_URL: `http://localhost:${port}`,
  NEXT_DIST_DIR: '.next-sim',
  // The Services Hub and Arcade hosts, and the single sign-on secret they share with the app (client fusionhub).
  SERVICES_ORIGIN: `http://serviceshub.localhost:${port}`,
  ARCADE_ORIGIN: `http://arcade.localhost:${port}`,
  BROKERHUB_ORIGIN: `http://brokerhub.localhost:${port}`,
  SSO_SECRET_FUSIONHUB: '73696d2d6675736f6e6875622d73736f2d6c6f63616c2d6f6e6c792d6b6579',
};
const next = createRequire(import.meta.url).resolve('next/dist/bin/next');
console.log(`[sim] simulated backend on http://localhost:${port}  (owner: admin@example.com / sim-admin-password)`);
console.log(`[sim] Services Hub: http://serviceshub.localhost:${port}  (Trader at /trader)   Arcade: http://arcade.localhost:${port}`);
console.log(`[sim] a simulated controller can talk to it through the real hooks: npm run mock:machine -- --site http://localhost:${port}`);
const child = spawn(process.execPath, [next, 'dev', '-p', port], { stdio: 'inherit', env });
child.on('exit', code => process.exit(code ?? 0));
