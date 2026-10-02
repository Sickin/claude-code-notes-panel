# notes-panel

A Claude Code mod: a markdown notepad in a pane beside the transcript, one per session.

## Commands

| Command | Does |
| --- | --- |
| `/note` | Toggle the pane |
| `/note <text>` | Append a line |
| `/note edit` / `/note view` | Switch mode (or press `e` / `v` in the pane) |
| `/note clear` | Empty this session's note, after a confirmation dialog |
| `/note prune [days]` | Delete other sessions' notes untouched for `days` (default 30), after confirmation |
| `/note -- <text>` | Append text literally, even a reserved word (`/note -- clear`) |

## Modes

- **View** renders the note with the `Markdown` element. Task lines (`- [ ]`, `- [x]`) are drawn as
  `☐` / `☑` buttons: click, or Tab + Enter, to toggle. Tasks inside fenced code are left alone.
- **Edit** is a line editor: one text field per line (Enter saves; typing saves after a pause),
  `x` deletes a line, `+` inserts one below, and the bottom field appends.

Mods have no multiline text field, hence the line editor. Clickable checkboxes inside `Markdown`
aren't supported by the mods API, hence the buttons; a task nested in a list loses its list styling.
`Markdown` caps at 10,000 characters per block, so very long runs are truncated in View (never in Edit).

## Storage

Notes live in the mod's own `$.store` (a JSON file under `~/.claude/plugins/store/`, 4 MiB total), under
`note:<session id>`. An emptied note is deleted. `/clear`, `/resume` and `/branch` reload the right note;
`/branch` copies the parent's note into the new session.

No network, model, process or telemetry calls. `claude plugin validate .` lists every call.

## Develop

```sh
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

Requires Claude Code 2.1.287+. Panes draw in the terminal and the Desktop app's Code tab.
