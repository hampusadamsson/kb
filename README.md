# kb

A small, local, single-user CLI kanban. Tickets are markdown files with YAML frontmatter.

## Overview

- No auth, no server, no TUI. Plain commands only, output to stdout.
- Stack: TypeScript, Node 22+, ESM.
  - `commander` — CLI
  - `yaml` — parsing; the Document API is used for rewrites so formatting and comments from hand edits are preserved
  - `zod` — config validation
  - `vitest` — tests
  - `tsc` — build
- Binary name: `kb`. Installed via `npm link`.

## Install

Requires Node 22+.

```sh
npm install && npm run build && npm link
```

## Development

```sh
npm test
```

## Config

File: `./kanban.yaml`, read from the current working directory only. If missing, `kb` errors with a hint to run `kb init`.

```yaml
name: default            # optional, renames default board (default "default")
columns: [todo, doing, done]   # ordered as listed
glob: "*.md"             # optional, default "*.md", e.g. "**/*.md"; relative to config dir
boards:                  # optional per-board column override; boards not listed use top-level columns
  another-board:
    columns: [backlog, active, shipped]
```

## Ticket format

A ticket is any markdown file matched by `glob` whose YAML frontmatter has `type: ticket`. Other files are ignored silently. Flat directory by default.

Reserved keys: `type`, `id`, `name`, `status`, `board`, `labels`, `comments`.

Example (`001-fix-login-bug.md`):

```markdown
---
type: ticket
id: "001"
name: Fix login bug
status: todo
board: another-board       # omitted on the default board
labels: [bug]
priority: high             # non-reserved: rendered as key:value label
comments:
  2025-06-01T14:32: blocked on X
  2025-06-01T14:32:05: unblocked, retrying
---

Free-form markdown body.
```

Rules:

- **id**: frontmatter property; any value (int or string). Filename is irrelevant for identity. New ids are zero-padded strings (`"001"`, padded to 3, grows past 999), written as quoted YAML strings (`id: "001"`) so they stay strings. Ids are displayed exactly as stored (`#001`; legacy `id: 1` shows `#1`; no id shows `#?`). `--id <value>` is stored exactly as given, as a string (`--id 7` stores `"7"`). Error if taken (duplicate rule below). `set` refuses to change id. Numeric id = integer or digit-only string; used for next-id (max numeric + 1, padded) and sorting.
- **Filename on add**: `./<id>-slug.md` (the id string, i.e. zero-padded `NNN` by default; slug from name). Override with `-f/--file` (relative to config dir). With `--id` the prefix is `<slug(id)>`. Files are never renamed.
- **name**: title stored as `name:`; body is free markdown.
- **status**: decides the column. Missing, or not a column of the ticket's board → shown in the "unsorted" group with a warning. Files are never auto-edited (except via fix/write commands).
- **board**: optional. Absent = default board. Written only when not default. Boards are discovered from tickets.
- **labels**: list property, rendered as `[x]` tags. All other non-reserved properties are rendered automatically as `key:value` labels.
- **comments**: map keyed by local time ISO to the minute, e.g. `2025-06-01T14:32: blocked on X`. On collision within the same minute, seconds are used (`2025-06-01T14:32:05`); if that also collides, seconds are added until a free key is found.

## Commands

| Command | Description |
|---|---|
|---|---|
| `kb init` | Write starter `kanban.yaml` (refuses if it exists) |
| `kb ls [text] [-b board] [-l label] [-p prop]` | List tickets grouped by board → column |
| `kb boards` | List discovered board names (plus configured ones) |
| `kb add [name]` | Create a ticket |
| `kb set <id>` | Modify a ticket |
| `kb mv <id> <status>` | Shortcut for `set -s` |
| `kb show <id>` | Print the ticket (properties + body + comments) |
| `kb edit <id>` | Open file in `$EDITOR` |
| `kb comment <id> "text"` | Append a timestamped comment |
| `kb fix [--dry-run]` | Assign/repair ids |
| `kb validate` | Check config and tickets |

### init

Writes a starter `kanban.yaml`; refuses if one exists.

```sh
kb init
```

### ls

All boards in sequence (or one with `-b`), grouped board → columns in config order with counts → "unsorted". Plain text; color only when stdout is a TTY.

```sh
kb ls
kb ls -b another-board
kb ls -l bug -p priority:high
kb ls -p '!status:done'
kb ls login
```

Filters:

| Flag | Meaning |
|---|---|
| `[text]` | Case-insensitive substring of the whole file (frontmatter + body) |
| `-l, --label <x>` | Ticket has label `x` (repeatable) |
| `-p, --property <key:value>` | Frontmatter `key` equals `value` (string compare; any element for lists). Any key, incl. `status`, `board`, `id` (repeatable) |
| `-p, --property <key>` | Property `key` exists |
| `-b, --board <board>` | Only this board |

All filters AND together. Prefix a value with `!` to negate it: `-l '!bug'`, `-p '!priority:low'` (also true when absent), `-p '!priority'` (absent), `'!wip'` (text not present). Use single quotes so the shell doesn't expand `!`. Boards with no matching tickets are omitted; counts reflect the filtered tickets; warnings are still computed from all tickets. No matches prints nothing (exit 0).

```
== default ==
todo (2)
  #001 Fix login bug   [bug] priority:high
  #004 Write docs
doing (1)
  #002 Refactor parser
```

### boards

```sh
kb boards
```

### add

Flags:

- `-n/--name`
- `-s/--status` (default: board's first column)
- `-b/--board`
- `-l/--label` (repeatable)
- `-p/--property key:value` (repeatable; split on first colon; value parsed as YAML and kept only if scalar — number/bool/string; maps, lists and null stay raw strings: `a:[1, 2]` → `"[1, 2]"`, `c:x: y` → `"x: y"`; empty value → `""`)
- `--body <text>` (`-` = stdin)
- `-c/--comment <text>` (initial comment)
- `-e/--edit` (open `$EDITOR` after; see `edit`)
- `-f/--file <path>`
- `--id <value>`

Always writes `type: ticket`. Prints `#<id> <path>`.

```sh
kb add "Fix login bug" -l bug -p priority:high
kb add -n "Write docs" -s doing -b another-board --body "see wiki"
echo "long body" | kb add "From stdin" --body -
kb add "Custom" -f notes/custom.md --id ABC-1 -c "created by hand"
```

### set

Same flags as `add` (except `-f` and `--id`), plus:

- `--unset key` (repeatable)
- `--unlabel x` (repeatable)

Refuses to change `id` or reserved `type`.

```sh
kb set 1 -p priority:low -l urgent
kb set 1 --unset priority --unlabel bug
kb set 1 -n "Fix login redirect bug"
```

### mv

```sh
kb mv 1 doing
```

### show

```sh
kb show 1
```

### edit

Uses `$EDITOR` only (`VISUAL` is ignored), default `vi`. Run via shell, so `EDITOR="code -w"` works.

```sh
kb edit 1
```

### comment

```sh
kb comment 1 "blocked on X"
```

### fix

For `type: ticket` files without an id: assign id from numeric filename prefix (`042-foo.md` → `"042"`, prefix kept as-is) if present and free, else the next padded id. Processing order: mtime, then path. Also repairs duplicate ids: the oldest (mtime, then path) keeps it; others get next free padded ids. New ids are max numeric + 1, skipping ids already used (including ones assigned in the same run). Never renames files. Prints each change.

```sh
kb fix --dry-run
kb fix
```

### validate

Checks: config parse + schema, frontmatter parse errors, missing id, duplicate ids, missing/unknown status, board not declared in `boards:` (warning only), `labels` not a list, `comments` not a map. Exit 0 if no errors, 1 if errors; warnings do not affect the exit code. Duplicate ids produce one error line per file.

```sh
kb validate
```

## Matching & sorting

- CLI id arguments match `String(id)` exactly first; if none match, numeric ids are compared by value (`kb show 1` finds `"001"`, and `001` finds `id: 1`). If the numeric fallback matches several tickets, it is an ambiguity error listing paths.
- Duplicate ids: ids equal by string, or both numeric with equal value (`1`, `"1"`, `"001"`), are duplicates. `ls` warns; commands targeting that id error, listing all file paths.
- Sorting within a column: numeric ids ascending first (ties by string, then path), then non-numeric ids alphabetical.

## Validation & fix

- `kb validate` reports problems (see above) and never modifies files.
- `kb fix` is the only command that repairs ids; use `--dry-run` to preview.
- Rewrites (`mv`/`set`/`comment`/`fix`) use the `yaml` Document API so frontmatter formatting and comments are preserved. The body is never touched.
- Writes never fold long strings (`lineWidth: 0`).
- CRLF: if the frontmatter starts with `---\r\n`, it is re-rendered with CRLF; the body is never modified.

## Design decisions

- **Markdown files as DB** — portable, and frontmatter is Obsidian-compatible.
- **`status` property drives the column** — no separate board state to keep in sync.
- **Minimal config** — just columns (and optional glob/boards); less to maintain.
- **id in frontmatter, not filename** — any file can be a ticket; renaming doesn't change identity.
- **`type: ticket` filter** — avoids treating README/notes as tickets.
- **Global ids across boards** — no ambiguity when addressing a ticket.
- **Boards discovered from files** — no registry to maintain; the config only overrides columns.
- **Plain commands over TUI** — simple and scriptable.
- **No WIP limits, no `rm` (delete the file), no auth** — out of scope for a single-user local tool.
- **YAML Document API for rewrites** — keeps hand edits (formatting, comments) intact.
- **Comments as timestamp-keyed map** — ordered, human-editable, no extra schema.
- **Dropped gray-matter** — a single YAML parser for read and write avoids divergent date/type parsing.

## Status

Implemented (v1). All commands working; vitest suite passing.

### Known limitations

- Rewrites preserve YAML comments, key order and body, but whitespace inside frontmatter is normalised by the yaml library (e.g. `key:   value` → `key: value`).
- `mv`/`set` to a status not in the board's columns only warns (ticket lands in unsorted).
- `node_modules` is always excluded from the glob scan.
