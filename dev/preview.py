"""See the Wayfinder pane without reloading the mod, then open dev/preview.html.

  py dev/preview.py                  a sample session (dev/preview.tsx)
  py dev/preview.py --live [id]      this machine's real state: a saved session's plan (the most
                                     recently updated one unless an id is given) and its real git

Runs the session through the mod's test kit, takes the pane's render tree and paints it in HTML at
the pane's width. An approximation of the desktop app's painting: layout logic shows, the app's
exact fonts and spacing may differ.
"""
import json, pathlib, shutil, subprocess, sys, time

ROOT = pathlib.Path(__file__).resolve().parent.parent
TMP = ROOT / 'hooks' / 'zz-preview.test.tsx'
STORE_DIR = pathlib.Path.home() / '.claude' / 'plugins' / 'store'


def run_kit(source: str) -> dict[str, str]:
    """Runs one test file through the kit; returns its PREVIEW and ASKED lines."""
    TMP.write_text(source, encoding='utf-8')
    try:
        out = subprocess.run(['claude', 'plugin', 'test', '.'], cwd=ROOT, capture_output=True, text=True, encoding='utf-8', shell=sys.platform == 'win32')
    finally:
        TMP.unlink()
    lines = {l.split(' ', 1)[0]: l.split(' ', 1)[1] for l in (out.stdout + out.stderr).splitlines() if l.startswith(('PREVIEW ', 'ASKED '))}
    if 'PREVIEW' not in lines:
        sys.exit('No preview tree printed:\n' + out.stdout[-3000:] + out.stderr[-3000:])
    return lines


def live(session: str | None) -> str:
    stores = sorted(STORE_DIR.glob('wayfinder_*.json'), key=lambda p: p.stat().st_mtime)
    if not stores:
        sys.exit(f'No Wayfinder store in {STORE_DIR}')
    store = json.loads(stores[-1].read_text(encoding='utf-8'))
    trails = {k[len('trail2:'):]: v for k, v in store.items() if k.startswith('trail2:') and isinstance(v, dict)}
    sid = session or max(trails, key=lambda k: trails[k].get('updatedAt', 0))
    if sid not in trails:
        sys.exit(f'No saved plan for session {sid}')
    cwd = next(iter(trails[sid].get('seen') or {}), str(ROOT).replace('\\', '/'))
    template = (ROOT / 'dev' / 'live.tsx').read_text(encoding='utf-8')
    answers: dict[str, dict] = {}
    # The mod's git calls depend on earlier answers: run, answer what it asked for real, until it asks nothing new.
    for _ in range(12):
        source = (template.replace('/*STORE*/ {}', json.dumps(store)).replace('/*GIT*/ {}', json.dumps(answers))
                  .replace("/*SESSION*/ ''", json.dumps(sid)).replace("/*CWD*/ ''", json.dumps(cwd)).replace('/*NOW*/ 0', str(int(time.time() * 1000))))
        lines = run_kit(source)
        asked = json.loads(lines.get('ASKED', '[]'))
        if not asked:
            print(f'Session {sid}: {trails[sid].get("goal")}')
            return lines['PREVIEW']
        for a in asked:
            r = subprocess.run(['git', '-c', 'core.fsmonitor=false', '--no-optional-locks', *a['args']], cwd=a['cwd'], capture_output=True, text=True, encoding='utf-8')
            answers['\0'.join([a['cwd'], *a['args']])] = {'exitCode': r.returncode, 'stdout': r.stdout}
    sys.exit('The mod kept asking git for more; giving up.')


if '--live' in sys.argv:
    rest = sys.argv[sys.argv.index('--live') + 1:]
    tree = live(rest[0] if rest else None)
else:
    tree = run_kit((ROOT / 'dev' / 'preview.tsx').read_text(encoding='utf-8'))['PREVIEW']
page = (ROOT / 'dev' / 'paint.html').read_text(encoding='utf-8').replace('/*TREE*/null', tree.replace('</', '<\\/'))
(ROOT / 'dev' / 'preview.html').write_text(page, encoding='utf-8')
print('Wrote', ROOT / 'dev' / 'preview.html')
