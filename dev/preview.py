"""See the Wayfinder pane without reloading the mod, then open dev/preview.html.

  py dev/preview.py                  a sample session (dev/preview.tsx)
  py dev/preview.py --live [id]      this machine's real state: a saved session's plan (the most
                                     recently updated one unless an id is given) and its real git
  add --fr                           as with Claude Code's language setting on French
  add --off                          as a session where Wayfinder is off (the autoStart setting off)
  add --ssh <host>                   with --live: that machine's store and git, over ssh
  add --cwd <dir>                    with --live: the session's folder, when its plan names no repo

Runs the session through the mod's test kit, takes the pane's render tree and paints it in HTML at
the pane's width; clicks on phase headers fold them and a step shows its dialog, as recorded. An approximation of the desktop app's painting: layout logic shows, the app's
exact fonts and spacing may differ.
"""
import json, pathlib, shlex, shutil, subprocess, sys, time

ROOT = pathlib.Path(__file__).resolve().parent.parent
TMP = ROOT / 'hooks' / 'zz-preview.test.tsx'
DUMP = ROOT / 'hooks' / 'zz-dump.ts'
STORE_DIR = pathlib.Path.home() / '.claude' / 'plugins' / 'store'


def run_kit(source: str) -> dict[str, str]:
    """Runs one test file through the kit; returns its PREVIEW and ASKED lines."""
    source = source.replace('/*AUTOSTART*/ true', 'false' if '--off' in sys.argv else 'true')
    TMP.write_text(source.replace("/*LANG*/ 'english'", "'french'" if '--fr' in sys.argv else "'english'"), encoding='utf-8')
    shutil.copy(ROOT / 'dev' / 'dump.ts', DUMP)
    try:
        out = subprocess.run(['claude', 'plugin', 'test', '.'], cwd=ROOT, capture_output=True, text=True, encoding='utf-8', shell=sys.platform == 'win32')
    finally:
        TMP.unlink()
        DUMP.unlink()
    lines = {l.split(' ', 1)[0]: l.split(' ', 1)[1] for l in (out.stdout + out.stderr).splitlines() if l.startswith(('PREVIEW ', 'ASKED '))}
    if 'PREVIEW' not in lines:
        sys.exit('No preview tree printed:\n' + out.stdout[-3000:] + out.stderr[-3000:])
    return lines


CWD = sys.argv[sys.argv.index('--cwd') + 1] if '--cwd' in sys.argv else None
SSH = sys.argv[sys.argv.index('--ssh') + 1] if '--ssh' in sys.argv else None


def git(cwd: str, args: list[str]) -> subprocess.CompletedProcess:
    argv = ['git', '-C', cwd, '-c', 'core.fsmonitor=false', '--no-optional-locks', *args]
    if SSH:
        return subprocess.run(['ssh', '-o', 'BatchMode=yes', SSH, shlex.join(argv)], capture_output=True, text=True, encoding='utf-8')
    return subprocess.run(argv, capture_output=True, text=True, encoding='utf-8')


def live(session: str | None) -> str:
    if SSH:
        out = subprocess.run(['ssh', '-o', 'BatchMode=yes', SSH, 'cat "$(ls -t ~/.claude/plugins/store/wayfinder_*.json | head -1)"'], capture_output=True, text=True, encoding='utf-8')
        if out.returncode != 0:
            sys.exit(f'No Wayfinder store on {SSH}: {out.stderr}')
        store = json.loads(out.stdout)
    else:
        stores = sorted(STORE_DIR.glob('wayfinder_*.json'), key=lambda p: p.stat().st_mtime)
        if not stores:
            sys.exit(f'No Wayfinder store in {STORE_DIR}')
        store = json.loads(stores[-1].read_text(encoding='utf-8'))
    trails = {k[len('trail2:'):]: v for k, v in store.items() if k.startswith('trail2:') and isinstance(v, dict)}
    sid = session or max(trails, key=lambda k: trails[k].get('updatedAt', 0))
    if sid not in trails:
        sys.exit(f'No saved plan for session {sid}')
    cwd = CWD or next(iter(trails[sid].get('seen') or {}), str(ROOT).replace('\\', '/'))
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
            r = git(a['cwd'], a['args'])
            answers['\0'.join([a['cwd'], *a['args']])] = {'exitCode': r.returncode, 'stdout': r.stdout}
    sys.exit('The mod kept asking git for more; giving up.')


if '--live' in sys.argv:
    rest = [a for a in sys.argv[sys.argv.index('--live') + 1:] if a not in ('--fr', '--off', '--ssh', SSH, '--cwd', CWD)]
    tree = live(rest[0] if rest else None)
else:
    tree = run_kit((ROOT / 'dev' / 'preview.tsx').read_text(encoding='utf-8'))['PREVIEW']
page = (ROOT / 'dev' / 'paint.html').read_text(encoding='utf-8').replace('/*TREE*/null', tree.replace('</', '<\\/'))
(ROOT / 'dev' / 'preview.html').write_text(page, encoding='utf-8')
print('Wrote', ROOT / 'dev' / 'preview.html')
