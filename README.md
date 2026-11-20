# wayfinder (working name)

A Claude Code mod that keeps a pane beside the chat answering "where are we?":

- **Plan**: the session's goal, a "where was I" line, and every step (code or not) marked done, current, blocked or todo, with result notes. Claude keeps it updated through the `mcp__wayfinder__progress` tool the mod adds. You can tick steps yourself in the pane, and Claude is told on your next message.
- **Repos**: every git repo the session touched, with live branch, uncommitted changes, commits ahead of the base branch and ahead/behind upstream.
- **Timeline**: branch switches, commits, finished steps. Commits made outside the session (by you or another session) are flagged, and Claude gets a note about them on your next message. Rewritten history (rebase, reset, amend) is flagged as such.
- **Other sessions**: a read-only list of your other sessions from the last 7 days with their goal and current step. It is never sent to Claude.

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

Open the pane with `/wayfinder`. `/wayfinder pause` stops it in every session (no git polling, no notes to Claude, the plan tool moves behind ToolSearch); `/wayfinder start` resumes it.

## Develop

```
claude plugin validate .
claude plugin test .
```

## Known limits

- Repos are found from the session's folder and from absolute paths in Claude's tool calls (`file_path`, `cd X`, `git -C X`). A relative `cd` is not followed.
- A commit you make by hand while Claude's turn is running is counted as the session's own.
- All sessions share one 4 MiB store (about 100 sessions). Nothing prunes it yet.
