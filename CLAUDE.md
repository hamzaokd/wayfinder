# Wayfinder: notes for Claude

A Claude Code mod (function-hooks plugin): a pane beside the chat with the session's plan on a branch
graph. User-facing docs: README.md. API types: `.claude-plugin/types/claude-code/index.d.ts`
(generated, gitignored; read it rather than guessing an API).

## Layout

- `hooks/register.tsx`: the hooks. Session start, the 15 s tick, commands, the progress tool,
  prompt notes to Claude, transcript scan at turn end, and the pane (`ui.render`).
- `hooks/graph.ts`: timeline rows and lane drawing (Svg slices), legend, terminal text version.
- `hooks/lib.ts`: pure logic (plan updates, edits per step, waiting/away, step dialog, shared files).
- `hooks/i18n.ts`: every string the person sees, EN and FR (FR typed as `typeof EN`). Notes to
  Claude stay English. Add both languages for any new string.
- `hooks/wayfinder.test.tsx`: the tests. `types/index.d.ts`: Trail and the atoms' shapes.
- `.claude-plugin/plugin.json`: manifest, including `userConfig` (the settings).

## Check every change

```
claude plugin test .
npx -y -p typescript@5.9.3 tsc -p .
claude plugin validate .
```

**Never change the pane blind.** Render it with `py dev/preview.py` (`--live [id]` for a real
session, `--off`, `--fr`) and look at `dev/preview.html` in a browser before handing it over. The
user pays tokens for every `/reload-plugins` round trip.

## Rules learned the hard way

- Clicks on an `Svg` never reach the mod. A `Box` with `position="absolute"` over a `Button` takes
  every click in the desktop app (fine in the browser preview, broken in the app). Rows are
  `[lane slice Svg][Button]` with nothing over them; a test guards against `"position":"absolute"`.
- Work actions from the pane put a draft in the message box (`$.prompt.fill`) and never send it:
  the text quotes step titles Claude wrote. Questions get a side answer (`$.model.fork`) in the pane.
- Git text and other sessions' goals reach Claude quoted (`quoted()`) and labelled as data.
- Off by default per session (`Trail.isOn`, settled at session start). Off costs no tokens: no notes,
  the tool deferred with a one-line description, no tick. Turn-end edit recording still runs so the
  shared-file warning sees off sessions.
- Changing Trail's fields: bump `PREFIX` and the atoms' shapes, unless the new field is optional.
- `shortcut:` comments mark known limits; keep that form.
