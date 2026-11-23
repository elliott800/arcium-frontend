#!/usr/bin/env python
"""Foundation tracker. Each repo has its own foundation: the core files that stay fixed unless the
evidence that proves them passes again. foundation.json (beside this file) names them and the evidence;
the same program serves every repo (arcium backend, arcium frontend, arcium production site).

    python foundation/foundation.py status          refresh FOUNDATION.md (files, evidence, required, layers)
    python foundation/foundation.py status --run    also run the command evidence now
    python foundation/foundation.py seal            seal: every evidence passes and is newer than the code
    python foundation/foundation.py check           exit 1 if a sealed file changed since the seal

foundation.json
    name        "arcium backend" ...
    groups      [{"id", "name", "files": [globs relative to the repo]}]
    evidence    [{"id", "name", "type": "suite" | "gui" | "command", ...}]
        suite    {"history": path, "stages": [...]}  the newest run whose stages all passed (a stage the
                 owner chose to skip counts as SKIPPED, a failure never) — older than the code: stale
        gui      {"report": path, "baseline": path, "sources": [dirs]}  every feature passing, no
                 regressions, run after the last change to the sources
        command  {"cmd": [...], "cwd": path}  run at seal (or status --run); exit 0 passes
    required    [{"id", "name", "path", "needs", "deferred"?}]   pieces the foundation must have
    layers      [{"level", "name", "items": [{"name", "status"}]}] what is built on top
"""
import glob
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SPEC = os.path.join(HERE, 'foundation.json')
SEAL = os.path.join(HERE, 'seal.json')
RUNS = os.path.join(HERE, 'evidence_runs.json')
REPORT = os.path.join(HERE, 'FOUNDATION.md')
FMT = '%Y-%m-%d %H:%M'


def p(rel):
    return os.path.normpath(os.path.join(ROOT, rel))


def load(path, default=None):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save(path, data):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(data, f, indent=1, sort_keys=True, default=str)
        f.write('\n')


def sha(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read().replace(b'\r\n', b'\n')).hexdigest()[:16]


def mtime(path):
    return datetime.fromtimestamp(os.path.getmtime(path))


# ── files ────────────────────────────────────────────────────────────────────
def group_files(spec):
    out = {}
    for g in spec['groups']:
        files = []
        for pat in g['files']:
            for f in sorted(glob.glob(p(pat), recursive=True)):
                if os.path.isfile(f) and '__pycache__' not in f and not f.endswith('.pyc'):
                    files.append((os.path.relpath(f, ROOT).replace(os.sep, '/'), f))
        out[g['id']] = files
    return out


def file_rows(spec, seal):
    sealed = (seal or {}).get('files', {})
    rows, seen = [], set()
    for gid, files in group_files(spec).items():
        for rel, f in files:
            seen.add(rel)
            state = 'NEW' if rel not in sealed else ('SEALED' if sha(f) == sealed[rel] else 'CHANGED')
            rows.append((gid, rel, state, mtime(f)))
    for rel in sorted(set(sealed) - seen):
        rows.append(('-', rel, 'MISSING', None))
    return rows


# ── evidence ─────────────────────────────────────────────────────────────────
def _stage(v):
    return str(v.get('result', '') if isinstance(v, dict) else v)


def suite_evidence(e):
    hist = load(p(e['history']), []) or []
    ok = [r for r in hist if all(_stage(r.get('stages', {}).get(s, '')).startswith(('PASS', 'SKIP')) for s in e['stages'])]
    if not ok:
        last = hist[-1] if hist else None
        return {'ok': False, 'at': None, 'summary': 'no run with every required stage passing'
                + (f" (last run {last.get('timestamp')}: {last.get('result')})" if last else '')}
    r = ok[-1]
    end = datetime.strptime(r['timestamp'], '%Y-%m-%d %H:%M:%S')
    started = datetime.fromtimestamp(end.timestamp() - float(r.get('total_seconds', 0)))
    stages = ', '.join(f"{s} {_stage(r['stages'].get(s, ''))[:4]}" for s in e['stages'])
    return {'ok': True, 'at': started, 'summary': f"run {r['timestamp']}: {stages}"}


def gui_evidence(e):
    rep, base = load(p(e['report'])), load(p(e.get('baseline', '')), {}) if e.get('baseline') else {}
    if not rep:
        return {'ok': False, 'at': None, 'summary': 'no GUI report'}
    at = datetime.fromisoformat(str(rep['at']).replace('Z', '+00:00')).astimezone().replace(tzinfo=None)
    ok = rep.get('passing') == rep.get('features') and not rep.get('regressions')
    newest = max((mtime(f) for d in e.get('sources', []) for f in glob.glob(os.path.join(p(d), '**', '*.*'), recursive=True)),
                 default=None)
    stale = newest is not None and newest > at
    summary = f"{rep.get('passing')}/{rep.get('features')} passing, {len(rep.get('regressions') or [])} regressions" \
              + (f'; stale (sources changed {newest:%Y-%m-%d %H:%M})' if stale else '')
    return {'ok': ok and not stale, 'at': at, 'summary': summary}


def command_evidence(e, run):
    runs = load(RUNS, {}) or {}
    if run:
        t0 = datetime.now()
        try:
            r = subprocess.run(e['cmd'], cwd=p(e.get('cwd', '.')), capture_output=True, text=True,
                               encoding='utf-8', errors='replace', timeout=e.get('timeout', 1800))
            tail = [l for l in (r.stdout or '').strip().splitlines() if l.strip()][-1:] or \
                   [l for l in (r.stderr or '').strip().splitlines() if l.strip()][-1:] or ['']
            runs[e['id']] = {'ok': r.returncode == 0, 'at': t0.strftime('%Y-%m-%d %H:%M:%S'), 'summary': tail[0][:200]}
        except Exception as exc:
            runs[e['id']] = {'ok': False, 'at': t0.strftime('%Y-%m-%d %H:%M:%S'), 'summary': f'{type(exc).__name__}: {exc}'}
        save(RUNS, runs)
    rec = runs.get(e['id'])
    if not rec:
        return {'ok': False, 'at': None, 'summary': 'not run yet (status --run or seal runs it)'}
    return {'ok': rec['ok'], 'at': datetime.strptime(rec['at'], '%Y-%m-%d %H:%M:%S'), 'summary': rec['summary']}


def evidence(spec, run=False):
    out = []
    for e in spec['evidence']:
        kind = e['type']
        ev = suite_evidence(e) if kind == 'suite' else gui_evidence(e) if kind == 'gui' else command_evidence(e, run)
        out.append(dict(ev, id=e['id'], name=e['name']))
    return out


# ── report ───────────────────────────────────────────────────────────────────
def render(spec, rows, evs, seal):
    names = {g['id']: g['name'] for g in spec['groups']}
    counts = {s: sum(1 for r in rows if r[2] == s) for s in ('SEALED', 'CHANGED', 'NEW', 'MISSING')}
    L = [f"# Foundation — {spec['name']}", '',
         f"Generated by `foundation/foundation.py status` ({datetime.now():{FMT}}). " + spec.get('about', ''), '',
         f"**Seal:** {('Foundation ' + seal['version'] + ', sealed ' + seal['sealed_at']) if seal else 'not sealed yet'}  ",
         f"**Files:** {counts['SEALED']} sealed, {counts['CHANGED']} changed, {counts['NEW']} new, {counts['MISSING']} missing",
         '', '## Evidence', '', '| Evidence | Result | At |', '|---|---|---|']
    for e in evs:
        L.append(f"| {e['name']} | {'PASS' if e['ok'] else 'NOT PASSING'}: {e['summary']} | {e['at']:{FMT}} |"
                 if e['at'] else f"| {e['name']} | {'PASS' if e['ok'] else 'NOT PASSING'}: {e['summary']} | - |")
    L += ['', '## Files', '']
    for gid in [g['id'] for g in spec['groups']]:
        grows = [r for r in rows if r[0] == gid]
        L += [f"### {names[gid]} ({len(grows)})", '', '| File | State | Changed |', '|---|---|---|']
        L += [f"| `{rel}` | {state} | {t:{FMT}} |" for _, rel, state, t in grows]
        L.append('')
    missing = [r for r in rows if r[2] == 'MISSING']
    if missing:
        L += ['### Sealed files no longer present', ''] + [f"- `{rel}`" for _, rel, _, _ in missing] + ['']
    if spec.get('required'):
        L += ['## Required pieces', '', '| Piece | State | Needs |', '|---|---|---|']
        for r in spec['required']:
            state = 'built' if os.path.isfile(p(r['path'])) else ('deferred' if r.get('deferred') else 'NOT BUILT')
            L.append(f"| {r['name']} (`{r['path']}`) | {state} | {r.get('needs', '')} |")
        L.append('')
    if spec.get('layers'):
        L += ['## Layers (built on the foundation)', '']
        for lay in spec['layers']:
            L += [f"**{lay['level']}. {lay['name']}**", ''] + [f"- {i['name']} — {i['status']}" for i in lay['items']] + ['']
    with open(REPORT, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(L))


# ── commands ─────────────────────────────────────────────────────────────────
def cmd_status(spec, args):
    seal = load(SEAL)
    rows, evs = file_rows(spec, seal), evidence(spec, run='--run' in args)
    render(spec, rows, evs, seal)
    counts = {s: sum(1 for r in rows if r[2] == s) for s in ('SEALED', 'CHANGED', 'NEW', 'MISSING')}
    print(f"{spec['name']}: {', '.join(f'{v} {k.lower()}' for k, v in counts.items() if v)}; "
          f"evidence: {', '.join(e['id'] + (' ok' if e['ok'] else ' NOT PASSING') for e in evs)}")
    print(f"report: {os.path.relpath(REPORT, ROOT)}")


def cmd_seal(spec, args):
    prev = load(SEAL) or {}
    rows, evs = file_rows(spec, prev), evidence(spec, run=True)
    problems = [f"{e['name']}: {e['summary']}" for e in evs if not e['ok']]
    newest = max((t for *_, t in rows if t), default=None)
    for e in evs:
        if e['ok'] and e['at'] and newest and newest > e['at']:
            changed = max((r for r in rows if r[3]), key=lambda r: r[3])
            problems.append(f"{e['name']} ran {e['at']:{FMT}}, before the last change ({changed[1]}, {changed[3]:{FMT}})")
    if any(r[2] == 'MISSING' for r in rows):
        problems.append('a sealed file is missing')
    if problems:
        print('Not sealed:\n  - ' + '\n  - '.join(problems))
        render(spec, rows, evs, prev or None)
        sys.exit(1)
    major, _, minor = str(prev.get('version', '0.0')).partition('.')
    version = f'{major or 0}.{int(minor or 0) + 1}' if prev else '1.0'
    commit = subprocess.run(['git', '-C', ROOT, 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
    seal = {'version': version, 'sealed_at': datetime.now().strftime(FMT), 'commit': commit,
            'evidence': {e['id']: e['summary'] for e in evs},
            'files': {rel: sha(p(rel)) for _, rel, state, _ in rows if state != 'MISSING'}}
    save(SEAL, seal)
    print(f"Sealed {spec['name']} Foundation {version}: {len(seal['files'])} files.")
    cmd_status(spec, [])


def cmd_check(spec, args):
    seal = load(SEAL)
    if not seal:
        print('No seal yet; nothing to check.')
        return
    changed = [rel for rel, h in seal['files'].items() if not os.path.isfile(p(rel)) or sha(p(rel)) != h]
    if changed:
        print(f"{spec['name']}: foundation changed since Foundation {seal['version']} "
              f"(needs its evidence again and a new seal):\n" + '\n'.join('  ' + c for c in changed))
        sys.exit(1)
    print(f"{spec['name']}: Foundation {seal['version']} intact ({len(seal['files'])} sealed files).")


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'status'
    spec = load(SPEC)
    {'status': cmd_status, 'seal': cmd_seal, 'check': cmd_check}.get(cmd, lambda *_: sys.exit(__doc__))(spec, sys.argv[2:])
