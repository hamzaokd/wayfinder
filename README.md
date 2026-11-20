# wayfinder (working name)

A Claude Code mod that keeps a pane beside the chat answering "where are we?":

- **Plan**: the session's goal, a "where was I" line, and every step (code or not) marked done, current, blocked or todo, with result notes. Claude keeps it updated through the `mcp__wayfinder__progress` tool the mod adds. You can tick steps yourself in the pane, and Claude is told on your next message.
- **Repos**: every git repo the session touched, with live branch, uncommitted changes, commits ahead of the base branch and ahead/behind upstream.
- **Timeline**: branch switches, commits, finished steps. Commits made outside the session (by you or another session) are flagged, and Claude gets a note about them on your next message. Rewritten history (rebase, reset, amend) is flagged as such.
- **Status strip**: a thin outlined line above the message box, colored by where the work stands: blue working on a step, orange waiting on you or stuck, red blocked, purple off plan (the plan changed this turn, or the current step wasn't in it), green goal reached. Nothing without a plan.
- **Other sessions**: a read-only list of your other sessions where Wayfinder is on, from the last 7 days, with their goal and current step. Only one thing about them reaches Claude: files both sessions edited in the last day, with the other session's goal, once per file, so it checks before touching them.

Data is saved per session in Claude Code's own plugin store, never in your repos.

## Install

On the machine that holds this folder, for every session (desktop app included), install it from the folder itself, so edits here reach sessions with `/reload-plugins`:

```
claude plugin marketplace add <this folder>
claude plugin install wayfinder@wayfinder
```

On another machine, at the prompt of a session (the repository is private, so that machine needs GitHub access: `gh auth login`):

```
/plugin install wayfinder --marketplace hamzaokd/wayfinder
```

Answer `y` to add the marketplace, then pick a scope (user = every session).

## Use

Wayfinder is **on in new sessions** (the "turn on in new sessions" setting below). With that setting off, it stays off in each session until you type `/wayfinder`, so it costs nothing where you don't use it. Off means no pane, no notes to Claude and the plan tool hidden behind ToolSearch. The session still records which files it edits, at no token cost, so other sessions' "also edited in another session" warning still sees it. A session that already has a plan (from before this setting, or a fork of one) starts on.

- `/wayfinder` turns it on in this session and opens the pane. With no plan yet, your next message also asks Claude to record the plan of the work so far, once.
- `/wayfinder-off` turns it off in this session.
- `/wayfinder-forget` hides the other sessions listed now until they move again (their plans stay saved).
- `/wayfinder-lang fr`, `en` or `auto` sets the pane's language in every session; `auto` follows Claude Code's `language` setting.

Under the timeline, a dim line estimates what Wayfinder cost in this session (about 4 characters a token): plan updates, notes to Claude, and the plan tool's description, counted once per turn though Claude Code mostly caches it. It counts from this version on.

**Settings** (the pane's folded Settings block, or `/config`, stored in `settings.json` under `pluginConfigs`): turn on in new sessions (default yes; `/wayfinder-off` turns one session off), how many days back other sessions show (7), and how many are listed (8). Other open sessions use a change after `/reload-plugins`.

The pane speaks French when Claude Code's `language` setting names French (`"language": "french"` in `~/.claude/settings.json`), and English otherwise.

## Develop

```
claude plugin validate .
claude plugin test .
```

To see the pane without reloading the mod, run `py dev/preview.py` (a sample session) or `py dev/preview.py --live [session id]` (a real saved session with its real git), then open `dev/preview.html` in a browser. Add `--off` for a session where Wayfinder is off, `--fr` for French. It mounts the pane through the test kit and paints its render tree; phase headers fold and steps show their dialog, as the kit recorded them. Layout logic shows; the app's own fonts and spacing may differ.

## Known limits

- Sessions closed before the mod was installed, and never reopened, are unknown to it: a mod only runs inside an open session.
- Repos are found from the session's folder and from absolute paths in Claude's tool calls (`file_path`, `cd X`, `git -C X`). A relative `cd` is not followed.
- A commit you make by hand while Claude's turn is running is counted as the session's own.
- All sessions share one 4 MiB store (about 100 sessions). Nothing prunes it yet.
