import 'server-only';
// The Fusion Analysis portal's content: one markdown file per core component, under content/fusion/<module>/.
// A file is front matter (title, module, order, summary, status), the owner's writing as markdown, and page
// controls as fenced ```control blocks (YAML) that src/app/fusion/_components/controls renders. Files come from
// the analysis workbook (scripts/fusion_import_workbook.py) and are edited by hand afterwards.
// Everything is checked as it loads: a bad file stops the page with a message naming the file, rather than
// rendering half of it.

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { FUSION_MODULES, type FusionModuleId } from './modules';
import { validSeriesExpr } from './series-expr';
import { privatePath } from '@/lib/private-content';

export const CONTROL_TYPES = [
  'table', 'factor-levels', 'pair-differentials', 'flow', 'checklist', 'stages', 'phases', 'chart-grid', 'cycle-probability',
  'cycle-position', 'outline',
] as const;
export type ControlType = typeof CONTROL_TYPES[number];

export interface ControlSummary {
  type: ControlType; title: string | null; source: string | null;
  readings: string[];           // factor-levels: the macro indicator ids of its rows
  charts: { name: string; series: string[]; needs: string | null }[];   // chart-grid: each chart's series
  outline: string | null;       // outline: the Playbook outline it links to
}

export interface FusionPage {
  module: FusionModuleId;
  slug: string;
  order: number;
  title: string;
  summary: string;
  status: 'live' | 'data-pending';
  body: string;                 // markdown with ```control blocks left in place (the renderer turns them into controls)
  file: string;                 // relative to the content root, for messages
  controls: ControlSummary[];   // the page's controls, for the hub's plan (data flow, checklist)
  buildNotes: string[];         // the bullets under "## Build notes": specs from the workbook not built yet
}

/** An entry the owner adds to the Playbook: one markdown file in content/fusion/playbook/entries/. */
export const ENTRY_KINDS = ['rule', 'setup', 'trade', 'review'] as const;
export const ENTRY_DIRECTIONS = ['long', 'short', 'pair', 'neutral'] as const;
export const ENTRY_STATES = ['idea', 'active', 'closed'] as const;
export interface PlaybookEntry {
  slug: string;
  title: string;
  date: string;                 // YYYY-MM-DD, the day it was written
  summary: string;
  kind: typeof ENTRY_KINDS[number];
  direction: typeof ENTRY_DIRECTIONS[number] | null;
  instruments: string[];
  state: typeof ENTRY_STATES[number];
  body: string;
  file: string;
}

export class FusionContentError extends Error {}

const ROOT = privatePath('fusion', path.join(process.cwd(), 'content', 'fusion'));   // the owner's private copy when set

function fail(file: string, msg: string): never {
  throw new FusionContentError(`content/fusion/${file}: ${msg}`);
}

/** The fields each control type must have (the renderer relies on them). */
const REQUIRED: Record<ControlType, string[]> = {
  table: ['columns', 'rows'],
  'factor-levels': ['rows', 'columns'],
  'pair-differentials': ['metrics'],
  flow: ['nodes'],
  checklist: ['items'],
  stages: ['stages'],
  phases: ['phases', 'denominators'],
  'chart-grid': [],                       // `series` or `sections`: checked below
  'cycle-probability': ['periods'],
  'cycle-position': ['bonds', 'stocks', 'commodities'],
  outline: ['outline'],
};

/** A small chart in a chart-grid: a name, and the series it plots (or, until there is one, what it needs). */
export interface ChartTileSpec { name: string; series: string | null; compare: string[]; units: string; needs: string | null; lines: { name: string; series: string; units: string }[]; section?: string }

/** A macro factor row's Data Hub series: `series: [{ name?, series, units? }]` (or one string). The factor's
 *  Current reading and its chart both come from these. */
export interface FactorSeries { name: string; series: string; units: string }
export function factorSeries(row: Record<string, unknown>): FactorSeries[] {
  const raw = row?.series;
  const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return items.map(t => (typeof t === 'string'
    ? { name: String(row.factor ?? t), series: t, units: '' }
    : { name: String((t as Record<string, unknown>).name ?? row.factor ?? ''), series: String((t as Record<string, unknown>).series ?? ''),
        units: String((t as Record<string, unknown>).units ?? '') })).filter(f => f.series);
}

export function chartTiles(spec: Record<string, unknown>): ChartTileSpec[] {
  // `sections: [{ title, series: [...] }]` puts the tiles under headings, in order, on one controls bar
  const sections = Array.isArray(spec.sections) ? (spec.sections as { title?: unknown; series?: unknown }[]) : null;
  const items: { t: unknown; section?: string }[] = sections
    ? sections.flatMap(s => ((s.series as unknown[]) ?? []).map(t => ({ t, section: String(s.title ?? '') })))
    : ((spec.series as unknown[]) ?? []).map(t => ({ t }));
  return items.map(({ t, section }) => {
    if (typeof t === 'string') return { name: t, series: null, compare: [], units: '', needs: null, lines: [], section };
    const o = t as Record<string, unknown>;
    return {
      name: String(o.name), series: typeof o.series === 'string' ? o.series : null,
      compare: Array.isArray(o.compare) ? o.compare.map(String) : [], units: typeof o.units === 'string' ? o.units : '',
      needs: typeof o.needs === 'string' ? o.needs : null, section,
      lines: Array.isArray(o.lines) ? (o.lines as Record<string, unknown>[]).map(l => ({ name: String(l.name ?? ''), series: String(l.series ?? ''), units: String(l.units ?? '') })).filter(l => l.series) : [],
    };
  });
}

export function parseControl(yamlText: string, file = 'inline'): Record<string, unknown> & { type: ControlType } {
  let spec: unknown;
  try {
    spec = parseYaml(yamlText);
  } catch (e) {
    fail(file, `a control block is not valid YAML (${(e as Error).message.split('\n')[0]})`);
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) fail(file, 'a control block must be a YAML mapping');
  const s = spec as Record<string, unknown>;
  const type = s.type as ControlType;
  if (!CONTROL_TYPES.includes(type)) fail(file, `unknown control type "${String(s.type)}" (known: ${CONTROL_TYPES.join(', ')})`);
  if (type === 'chart-grid' && s.series === undefined && s.sections === undefined) fail(file, 'the chart-grid control needs "series" or "sections"');
  for (const key of REQUIRED[type]) {
    if (s[key] === undefined || s[key] === null) fail(file, `the ${type} control needs "${key}"`);
  }
  for (const key of ['rows', 'columns', 'nodes', 'items', 'stages', 'phases', 'denominators', 'series', 'metrics', 'periods']) {
    if (s[key] !== undefined && !Array.isArray(s[key])) fail(file, `"${key}" in the ${type} control must be a list`);
  }
  // a factor row may name the macro indicators that give its current reading (ids from src/lib/macro.ts)
  if (type === 'factor-levels') {
    for (const row of s.rows as unknown[]) {
      const r = (row ?? {}) as Record<string, unknown>;
      if (r.reading === undefined) continue;
      const ids = Array.isArray(r.reading) ? r.reading : [r.reading];
      if (!ids.every(id => typeof id === 'string' && /^[a-z0-9_]+$/.test(id))) {
        fail(file, `the reading of factor "${String(r.factor)}" must be a macro indicator id or a list of them`);
      }
    }
  }
  if (type === 'chart-grid') {
    const sections = Array.isArray(s.sections) ? (s.sections as { series?: unknown }[]) : [];
    const all = [...((Array.isArray(s.series) ? s.series : []) as unknown[]), ...sections.flatMap(x => (Array.isArray(x.series) ? x.series : []) as unknown[])];
    for (const t of all) {
      if (typeof t === 'string') continue;
      const o = (t ?? {}) as Record<string, unknown>;
      if (typeof o.name !== 'string' || !o.name.trim()) fail(file, 'every chart in a chart-grid needs a "name"');
      const lineExprs = Array.isArray(o.lines) ? (o.lines as Record<string, unknown>[]).map(l => l.series) : [];
      const exprs = [...(o.series !== undefined ? [o.series] : []), ...lineExprs, ...(Array.isArray(o.compare) ? o.compare : o.compare !== undefined ? [o.compare] : [])];
      if (o.compare !== undefined && !Array.isArray(o.compare)) fail(file, `"compare" of chart "${o.name}" must be a list`);
      for (const e of exprs) {
        if (typeof e !== 'string' || !validSeriesExpr(e)) fail(file, `chart "${o.name}": "${String(e)}" is not a series (fred:ID[@yoy], price:SYMBOL, or A - B)`);
      }
      if (!exprs.length && typeof o.needs !== 'string') fail(file, `chart "${o.name}" needs a series, lines, a compare list, or "needs" naming its source`);
    }
  }
  if (type === 'cycle-position') {
    for (const key of ['bonds', 'stocks', 'commodities', 'commodities_proxy']) {
      if (s[key] !== undefined && (typeof s[key] !== 'string' || !/^[A-Z0-9._^=-]{1,15}$/.test(s[key] as string))) fail(file, `"${key}" in the cycle-position control must be a symbol`);
    }
  }
  if (type === 'outline') {
    if (typeof s.outline !== 'string' || !/^[a-z0-9-]+$/.test(s.outline)) fail(file, 'the outline control needs "outline": the file name of a Playbook outline');
    if (!fs.existsSync(path.join(OUTLINES, `${s.outline}.md`))) fail(file, `no Playbook outline "${s.outline}" in ${OUTLINES_DIR}/`);
  }
  return s as Record<string, unknown> & { type: ControlType };
}

/** The macro indicator ids a factor row reads its current value from (none when it names none). */
export function rowReadings(row: Record<string, unknown>): string[] {
  const r = row.reading;
  return (Array.isArray(r) ? r : r === undefined ? [] : [r]).map(String);
}

function splitFile(file: string, abs: string): { front: Record<string, unknown>; body: string } {
  const raw = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) fail(file, 'missing front matter (--- … ---)');
  let front: unknown;
  try {
    front = parseYaml(m[1]) ?? {};
  } catch (e) {
    fail(file, `front matter is not valid YAML (${(e as Error).message.split('\n')[0]})`);
  }
  return { front: front as Record<string, unknown>, body: m[2].trim() };
}

function needText(file: string, front: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (typeof front[key] !== 'string' || !(front[key] as string).trim()) fail(file, `front matter needs "${key}"`);
  }
}

function buildNotesOf(body: string): string[] {
  const at = body.search(/^## Build notes$/m);
  if (at < 0) return [];
  const rest = body.slice(at).split('\n').slice(1);
  const end = rest.findIndex(l => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end))
    .filter(l => /^\s*[-*] /.test(l)).map(l => l.replace(/^\s*[-*] /, '').trim()).filter(Boolean);
}

function parseFile(module: FusionModuleId, name: string): FusionPage {
  const file = `${module}/${name}`;
  const { front, body } = splitFile(file, path.join(ROOT, module, name));
  needText(file, front, ['title', 'summary']);
  if (front.module !== module) fail(file, `front matter module "${String(front.module)}" does not match its folder "${module}"`);
  const status = front.status ?? 'live';
  if (status !== 'live' && status !== 'data-pending') fail(file, `status must be live or data-pending, not "${String(status)}"`);
  const controls: ControlSummary[] = [];
  for (const block of body.matchAll(/```control\n([\s\S]*?)```/g)) {
    const spec = parseControl(block[1], file);
    controls.push({
      type: spec.type, title: typeof spec.title === 'string' ? spec.title : null,
      source: typeof spec.source === 'string' ? spec.source : null,
      readings: spec.type === 'factor-levels' ? (spec.rows as Record<string, unknown>[]).flatMap(r => rowReadings(r ?? {})) : [],
      charts: spec.type === 'chart-grid'
        ? chartTiles(spec).map(t => ({ name: t.name, series: [...(t.series ? [t.series] : []), ...t.compare], needs: t.needs })) : [],
      outline: spec.type === 'outline' ? String(spec.outline) : null,
    });
  }
  return {
    module, slug: name.replace(/\.md$/, ''), order: Number(front.order ?? 99), title: String(front.title),
    summary: String(front.summary), status: status as FusionPage['status'], body, file, controls, buildNotes: buildNotesOf(body),
  };
}

/** Every page of one module, in order. */
export function modulePages(module: FusionModuleId): FusionPage[] {
  const dir = path.join(ROOT, module);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(n => n.endsWith('.md'))
    .map(n => parseFile(module, n))
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

/** Every module that has content, with its pages. */
export function allContent(): { id: FusionModuleId; pages: FusionPage[] }[] {
  return FUSION_MODULES.filter(m => m.contentDir).map(m => ({ id: m.id, pages: modulePages(m.id) }));
}

// Playbook entries: the owner's own additions (setups, trades, reviews, new rules), one file each, kept apart
// from the pages imported from the workbook so a re-import never touches them.
export const ENTRIES_DIR = 'content/fusion/playbook/entries';
const ENTRIES = path.join(ROOT, 'playbook', 'entries');

function parseEntry(name: string): PlaybookEntry {
  const file = `playbook/entries/${name}`;
  const { front, body } = splitFile(file, path.join(ENTRIES, name));
  needText(file, front, ['title', 'summary']);
  // YAML reads an unquoted 2026-11-07 as a date
  const date = front.date instanceof Date ? front.date.toISOString().slice(0, 10) : String(front.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(file, `date must be YYYY-MM-DD, not "${date}"`);
  function pick<T extends string>(key: string, allowed: readonly T[], fallback: T | null): T | null {
    const v = front[key] ?? fallback;
    if (v === null) return null;
    if (!(allowed as readonly string[]).includes(String(v))) fail(file, `${key} must be one of ${allowed.join(', ')}, not "${String(v)}"`);
    return String(v) as T;
  }
  const instruments = front.instruments ?? [];
  if (!Array.isArray(instruments)) fail(file, '"instruments" must be a list');
  for (const block of body.matchAll(/```control\n([\s\S]*?)```/g)) parseControl(block[1], file);
  return {
    slug: name.replace(/\.md$/, ''), title: String(front.title), date, summary: String(front.summary),
    kind: pick('kind', ENTRY_KINDS, 'setup')!, direction: pick('direction', ENTRY_DIRECTIONS, null),
    instruments: instruments.map(i => String(i).toUpperCase()), state: pick('state', ENTRY_STATES, 'idea')!, body, file,
  };
}

// Study outlines: the strategy lists, checklists and steps from the analysis pages, kept in the owner's words
// in the Playbook as outlines for later studies. Each names the page it came from (`from: module/page`), and
// that page links to it with an ```control outline block instead of repeating it.
export const OUTLINES_DIR = 'content/fusion/playbook/outlines';
const OUTLINES = path.join(ROOT, 'playbook', 'outlines');

export interface PlaybookOutline { slug: string; title: string; summary: string; order: number; from: { module: FusionModuleId; slug: string }; body: string; file: string }

function parseOutline(name: string): PlaybookOutline {
  const file = `playbook/outlines/${name}`;
  const { front, body } = splitFile(file, path.join(OUTLINES, name));
  needText(file, front, ['title', 'summary', 'from']);
  const m = String(front.from).match(/^([a-z]+)\/([a-z0-9-]+)$/);
  if (!m || !FUSION_MODULES.some(x => x.id === m[1] && x.contentDir)) fail(file, `from must be module/page, not "${String(front.from)}"`);
  if (!fs.existsSync(path.join(ROOT, m[1], `${m[2]}.md`))) fail(file, `from names a page that does not exist: content/fusion/${m[1]}/${m[2]}.md`);
  for (const block of body.matchAll(/```control\n([\s\S]*?)```/g)) parseControl(block[1], file);
  return { slug: name.replace(/\.md$/, ''), title: String(front.title), summary: String(front.summary), order: Number(front.order ?? 99),
           from: { module: m[1] as FusionModuleId, slug: m[2] }, body, file };
}

/** The Playbook's study outlines, in order. */
export function playbookOutlines(): PlaybookOutline[] {
  if (!fs.existsSync(OUTLINES)) return [];
  return fs.readdirSync(OUTLINES).filter(n => n.endsWith('.md') && !n.startsWith('_')).map(parseOutline)
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

/** One page of a module, or undefined. */
export function modulePage(module: FusionModuleId, slug: string): FusionPage | undefined {
  return modulePages(module).find(p => p.slug === slug);
}

/** The owner's Playbook entries, newest first. Files starting with "_" (the template) are not entries. */
export function playbookEntries(): PlaybookEntry[] {
  if (!fs.existsSync(ENTRIES)) return [];
  return fs.readdirSync(ENTRIES)
    .filter(n => n.endsWith('.md') && !n.startsWith('_'))
    .map(parseEntry)
    .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
}
