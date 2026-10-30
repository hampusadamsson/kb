# kb

A small, local, single-user CLI kanban. Tickets are markdown files with YAML frontmatter.

## Overview

- CLI plus an optional local web UI (`kb web`). No auth (see [security model](#security-model)), no TUI. Plain commands, output to stdout.
- Stack: TypeScript, Node 22+, ESM.
  - `commander` — CLI
  - `yaml` — parsing; the Document API is used for rewrites so formatting and comments from hand edits are preserved
  - `zod` — config validation
  - `vitest` — tests
  - `tsc` — build
  - Web UI: Node built-in `http` and a vanilla JS frontend — no extra dependencies, no build step for the frontend
- Binary name: `kb`. Installed via `npm link`.

## Install

Requires Node 22+.

```sh
npm install && npm run build && npm link
```

## Development

```sh
npm run build && npm test
```

`npm run build` runs `tsc` and copies `src/web/public` to `dist/web/public`. The e2e web tests need a built `dist`, so run the build before the tests.

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
| `kb web [--host <addr>] [--port <n>] [--no-open]` | Start the local web UI |

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

### web

Starts the local web UI for the board in the current directory (needs `kanban.yaml`). See [Web UI](#web-ui-kb-web).

```sh
kb web
kb web --port 8080 --no-open
kb web --host 0.0.0.0
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

## Web UI (`kb web`)

### Launch

```sh
kb web [--host <addr>] [--port <n>] [--no-open]
```

- Requires `kanban.yaml` in the current directory (errors otherwise).
- `--host` default `127.0.0.1`.
- `--port` default `4747`; if busy, the next ports are tried, up to 50 times. With an explicit `--port` the port is strict: it errors if busy.
- Prints `kb web running at <url>`. For a wildcard host (`0.0.0.0`, `::`) the URL uses `localhost` and a `listening on <host>:<port>` line is added.
- A non-loopback host prints a no-auth warning to stderr.
- The browser is opened unless `--no-open`.
- Ctrl-C / SIGTERM shut down cleanly.

### Features

- Board tabs plus an **All** tab. Columns follow the config; the `unsorted` column is shown but is not a drop target.
- Cards; drag a card to another column of the **same board** to change its `status`. Cross-board drags are ignored.
- Create dialog: global **New** button, or the per-column **+** (preset status).
- Detail dialog: name, status, board, labels, properties, body, comments (add comments there). Comment keys have minute granularity (seconds on collision).
- Filter bar: text, labels, properties, with `!` negation as in `kb ls`. State lives in the URL hash: `#board=..&text=..&l=..&p=..`.
- Maintenance panel: `validate` results, and `fix` with a dry-run preview before applying. Parse errors are shown only there.
- Tickets with duplicate ids or no id are read-only and carry badges (use `fix`).
- Stale-edit banner: edits send the ticket's mtime; if the file changed on disk the UI offers **Reload** or **Overwrite**.
- Not available in the UI: `init` and `edit`.

### Live updates

- `fs.watch` (recursive) on the board dir, filtered by `glob`; `kanban.yaml` changes count too. `node_modules`, `dist` and `.git` are ignored.
- Debounced 100 ms, with a 1 s max-wait. Events go out over SSE (`/api/events`); the UI refetches on every event.
- If the watcher is unavailable there are no live updates (the API still works).

### Security model

There is no auth. Anyone who can reach the server can read and edit tickets. Guards:

- Same-origin: a request whose `Origin` differs from `Host` gets 403; `Sec-Fetch-Site`, if sent, must be `same-origin` or `none`.
- Writes (non-GET) require `Content-Type: application/json` (else 415).
- Loopback bind: the `Host` header is validated (421 on mismatch) against DNS rebinding.
- Non-loopback bind: the Host check is skipped so LAN access works. Only use this on networks you trust.
- CSP and frame protections (`frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`).
- `file` for add must stay inside the board dir and end in `.md`. This also applies to CLI `add -f`.

### REST API

JSON in and out. Errors: `{ "error": "...", "code": "..." }`.

| Endpoint | Description |
|---|---|
| `GET /api/board` | Board view; query `board`, `text`, `label`, `property` (filters as in `ls`) |
| `GET /api/tickets/:id` | Ticket detail (ids URL-encoded) |
| `PATCH /api/tickets/:id` | Core patch fields (`name`, `status`, `board`, `addLabels`, `removeLabels`, `setProps`, `unsetProps`, `body`, `comment`) plus optional `mtime`; stale → 409 `code: "stale"` with `currentMtime` |
| `POST /api/tickets` | Create (201) |
| `POST /api/tickets/:id/comments` | Add comment, body `{ text, mtime? }` (201) |
| `GET /api/validate` | Validation result |
| `POST /api/fix` | Body `{ dryRun }`, default `true` |
| `GET /api/events` | SSE stream (`changed` events) |

Status mapping: `not-found` 404; `ambiguous`, `exists`, `stale` 409; `invalid`, `parse` 400; `unsupported` 415; host not allowed 421; `config` 500; body too large (1 MB) 413.

### Frontend

`src/web/public/`: vanilla ES modules, no build step, no dependencies. `index.html`, `style.css`, `app.js` (wiring), `api.js`, `board.js`, `dialog.js`, `filters.js`, `maintenance.js`, `dom.js`, and `logic.js` (pure logic, unit-tested).

## Architecture

Three layers:

```
src/core/   UI-agnostic domain/service layer (Kanban API, config, tickets, frontmatter, parse helpers, KanbanError)
src/cli/    thin adapter: commander wiring, flag parsing, output formatting, stdin, $EDITOR, colour/TTY, exit codes
src/web/    second adapter over the core: http server, REST API, fs watcher + SSE, vanilla frontend in public/
src/index.ts  public library entry (re-exports core)
```

The CLI parses flags into plain objects, calls `Kanban`, and formats the structured result. Core methods
take structured options and return plain data (no strings meant for display, no printing); failures throw
`KanbanError` with a `code` (`not-found`, `ambiguous`, `invalid`, `exists`, `config`, `parse`).
Text syntax shared by UIs (`key:value` properties, `!` negation in filters) lives in `src/core/parse.ts`.

To build another UI (TUI, web, MCP): import from `kb` (or `src/index.ts`), call `Kanban`, render the results yourself.
Reading stdin, spawning editors and warnings output are the UI's job (use `pathOf(id)` to find the file to edit).

```ts
import { createKanban, KanbanError } from "kb";

const kb = createKanban({ dir: process.cwd() });
const { id, warnings } = kb.add({ name: "Fix login", labels: ["bug"], properties: { priority: "high" } });
kb.move(id, "doing");
kb.comment(id, "started");
const { boards } = kb.list({ labels: ["bug"], props: ["!priority:low"] });
const { errors } = kb.validate();
kb.fix({ dryRun: true }); // [{ path, from, to }]
```

Boundary rule: nothing in `src/core` may import `commander` or `../cli`, or use `process.stdout`/`stderr`/`exit`/`argv`/`env`
or `readline`. Nothing in `src/core` may import `../web` either. Enforced by `test/architecture.test.ts`.

## Design decisions

- **Markdown files as DB** — portable, and frontmatter is Obsidian-compatible.
- **`status` property drives the column** — no separate board state to keep in sync.
- **Minimal config** — just columns (and optional glob/boards); less to maintain.
- **id in frontmatter, not filename** — any file can be a ticket; renaming doesn't change identity.
- **`type: ticket` filter** — avoids treating README/notes as tickets.
- **Global ids across boards** — no ambiguity when addressing a ticket.
- **Boards discovered from files** — no registry to maintain; the config only overrides columns.
- **Plain commands over TUI** — simple and scriptable.
- **Built-in `http` + vanilla frontend** — no dependencies, no build step for the UI.
- **SSE + `fs.watch` over polling** — immediate updates, no idle load.
- **Thin REST over core** — the API only maps HTTP to `Kanban` calls; rules stay in core.
- **No manual card order** — order is by id, so drag only changes status.
- **Loopback bind by default, with Host/Origin/Content-Type guards** — no auth, so keep it local; CSRF and DNS rebinding are blocked.
- **No WIP limits, no `rm` (delete the file), no auth** — out of scope for a single-user local tool (`kb web` relies on its bind/guard model instead).
- **`add -f` stays inside the board dir** — must be a relative `.md` path under the config dir.
- **YAML Document API for rewrites** — keeps hand edits (formatting, comments) intact.
- **Comments as timestamp-keyed map** — ordered, human-editable, no extra schema.
- **Dropped gray-matter** — a single YAML parser for read and write avoids divergent date/type parsing.

## Status

Implemented: v1 plus the web UI (`kb web`). All commands working; vitest suite passing.

### Known limitations

- Rewrites preserve YAML comments, key order and body, but whitespace inside frontmatter is normalised by the yaml library (e.g. `key:   value` → `key: value`).
- `mv`/`set` to a status not in the board's columns only warns (ticket lands in unsorted).
- `node_modules` is always excluded from the glob scan.
- Web UI is not tested in real browsers beyond a headless Chrome smoke check (synthetic drag events).
- The create dialog and the maintenance fix buttons have not been exercised in a browser.
