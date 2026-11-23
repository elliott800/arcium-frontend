// Lint (house rule): every source file starts by saying what it is.
//
// The first line of each .ts, .tsx and .css file under src/ (after a 'use client' or 'server-only' line) must be a
// comment: one or a few lines naming the page, dashboard, panel, route or helper and where it sits in the site, so
// someone new can open any file and know where they are. Section markers inside a long file use the same style:
//     // ── section name ──            (TypeScript)
//     /* ── section name ── */          (CSS)
//
//     node scripts/check-headers.mjs        part of `npm run lint`; exits 1 and lists the files without a header
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIRECTIVE = /^(['"]use (client|server)['"];?|import ['"]server-only['"];?)$/;

function* files(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (/\.(tsx?|css)$/.test(e.name) && !e.name.endsWith('.d.ts')) yield p;
  }
}

function hasHeader(text) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || DIRECTIVE.test(line)) continue;
    return line.startsWith('//') || line.startsWith('/*');
  }
  return false;
}

const missing = [...files(join(ROOT, 'src'))].filter(f => !hasHeader(readFileSync(f, 'utf8')));
if (missing.length) {
  console.error(`${missing.length} file(s) without a header comment (say what the file is on its first line):`);
  for (const f of missing) console.error('  ' + relative(ROOT, f).replace(/\\/g, '/'));
  process.exit(1);
}
console.log('headers: every source file says what it is');
