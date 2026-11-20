"""See the Wayfinder pane without reloading the mod: py dev/preview.py, then open dev/preview.html.

Runs dev/preview.tsx (a sample session) through the mod's test kit, takes the pane's render tree
and paints it in HTML at the pane's width. An approximation of the desktop app's painting: layout
logic shows, the app's exact fonts and spacing may differ.
"""
import json, pathlib, shutil, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
tmp = ROOT / 'hooks' / 'zz-preview.test.tsx'
shutil.copy(ROOT / 'dev' / 'preview.tsx', tmp)
try:
    out = subprocess.run(['claude', 'plugin', 'test', '.'], cwd=ROOT, capture_output=True, text=True, encoding='utf-8', shell=sys.platform == 'win32')
finally:
    tmp.unlink()
line = next((l for l in out.stdout.splitlines() + out.stderr.splitlines() if l.startswith('PREVIEW ')), None)
if not line:
    sys.exit('No preview tree printed:\n' + out.stdout[-3000:] + out.stderr[-3000:])
tree = line[len('PREVIEW '):]
page = (ROOT / 'dev' / 'paint.html').read_text(encoding='utf-8').replace('/*TREE*/null', tree.replace('</', '<\\/'))
(ROOT / 'dev' / 'preview.html').write_text(page, encoding='utf-8')
print('Wrote', ROOT / 'dev' / 'preview.html')
