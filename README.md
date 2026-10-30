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
    automations: []      # optional, see Automations
automations: []          # optional rules for the default board, see Automations
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
| `kb web [--host <addr>] [--port <n>] [--no-open] [--no-automation]` | Start the local web UI |

Global flag `--no-automation` (also accepted after `add`, `set`, `mv`, `web`) skips [automations](#automations).

### init

Writes a starter `kanban.yaml`; refuses if one exists.

```sh
kb init
```

### ls

Prints **JSON by default** (one object, easy for scripts and agents); `--format text` gives the board view for humans. Matching tickets are listed flat in board → column → id order (unsorted last).

```sh
kb ls                       # JSON, first 50 tickets
kb ls --full -l bug         # include body and comments
kb ls --limit 200           # raise the limit
kb ls --limit 0             # no limit
kb ls --format text         # human board view
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

Output options:

| Flag | Meaning |
|---|---|
| `--format <json\|text>` | `json` (default) or `text` |
| `--full` | JSON: add `body` and `comments` to each ticket |
| `--limit <n>` | JSON: max tickets, default **50**, `0` = unlimited. Non-integers are an error |

JSON shape (`total` = matches before the limit):

```json
{
  "total": 120, "shown": 50, "limit": 50, "truncated": true,
  "tickets": [
    { "id": "001", "name": "Fix login bug", "board": "default", "status": "todo", "column": "todo",
      "labels": ["bug"], "props": { "priority": "high" }, "path": "001-fix-login-bug.md" }
  ]
}
```

`id` and `status` are `null` when missing; `column` is `"unsorted"` for a missing or unknown status. With `--full` each ticket also has `body` (string) and `comments` (`{ "<time>": "<text>" }`). When the limit cuts the list, a warning goes to **stderr** (`warning: showing 50 of 120 tickets (limit 50); use --limit <n>, or --limit 0 for all, or add filters`) so stdout stays valid JSON; `truncated` is also `true`. Other warnings (unsorted, duplicate ids, parse errors) go to stderr too. Filters apply before the limit.

All filters AND together. Prefix a value with `!` to negate it: `-l '!bug'`, `-p '!priority:low'` (also true when absent), `-p '!priority'` (absent), `'!wip'` (text not present). Use single quotes so the shell doesn't expand `!`. Boards with no matching tickets are omitted; counts reflect the filtered tickets; warnings are still computed from all tickets. No matches: JSON gives an empty `tickets` list, text prints nothing (exit 0). `--format text` ignores `--full` and `--limit`:

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

Checks: config parse + schema, automation rules (see [Automations](#validation)), frontmatter parse errors, missing id, duplicate ids, missing/unknown status, board not declared in `boards:` (warning only), automation stuck in `running` for over 5 minutes (warning), `labels` not a list, `comments` not a map. Exit 0 if no errors, 1 if errors; warnings do not affect the exit code. Duplicate ids produce one error line per file.

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
- Create: the **+** in each column header opens the create dialog with that board and status preset. There is no global "New" button.
- Detail dialog: name, status, board, labels, properties, body, comments (add comments there). Comment keys have minute granularity (seconds on collision).
- Filter bar: text, labels, properties, with `!` negation as in `kb ls`. State lives in the URL hash: `#board=..&text=..&l=..&p=..`.
- **Settings** (header button, badge = issue count):
  - *Board config* form for `kanban.yaml`: default board name, `glob`, ordered columns (rename inline, reorder, add, remove), and per-board column overrides (add, rename, remove). Saving keeps your YAML comments and unrelated keys.
  - Renaming a column rewrites `status` on every ticket using it; renaming a board rewrites an explicit `board:`. Before anything is written the UI shows how many ticket files will change (dry run) and asks to confirm.
  - Removing a column is **blocked** while tickets still use it (the error lists them). Removing a board override is allowed; its tickets fall back to the default columns. Unsorted tickets never block.
  - Invalid configs (empty/duplicate columns, empty name or glob) are refused and nothing is written. If `kanban.yaml` changes on disk while the form is open, a banner offers **Reload** (and **Overwrite** after a stale save).
  - *Health*: `validate` results and board warnings; `fix` with a dry-run preview before applying. Parse errors are shown only here.
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
| `GET /api/config` | `{ config: {name, columns, glob, boards}, mtime }` |
| `PUT /api/config` | Body `{ config, renames?, mtime?, dryRun? }` → `{ dryRun, changes, configChanged, mtime }`. `renames` is `{ columns: { "": {old: new}, <board>: {old: new} }, boards: {old: new} }`. `dryRun` (only when exactly `true`) reports ticket edits without writing. Stale `mtime` → 409 `code: "stale"`; invalid config or a column still in use → 400 `invalid` |
| `POST /api/automation/test` | Render and really run a script with a sample ticket (see [Automations](#automations)) |
| `GET /api/automation/log` | `{ runs }`: the last 20 automation runs, newest first |
| `GET /api/events` | SSE stream (`changed` events) |

`/api/automation/test` body: `{ run, event?: "moved_to"|"created_in", board?, sample?: { id, name, body, status, from, to, labels, props } }` → `{ command, result: { exitCode, stdout, stderr, error? } }`. Unknown variable or bad placeholder position → 400 `invalid`; automations disabled → 503 `disabled`; more than 2 test runs in flight → 429 `busy`. Test runs are not logged and touch no ticket.

Status mapping: `not-found` 404; `ambiguous`, `exists`, `stale` 409; `invalid`, `parse` 400; `unsupported` 415; host not allowed 421; `config` 500; body too large (1 MB) 413.

### Frontend

`src/web/public/`: vanilla ES modules, no build step, no dependencies. `index.html`, `style.css`, `app.js` (wiring), `api.js`, `board.js`, `dialog.js`, `filters.js`, `settings.js`, `automations.js` (Settings → Automations builder and Last runs), `dom.js`, and `logic.js` (pure logic, unit-tested).

## Automations

A rule runs a shell script when a ticket is moved to a column or created in one. Rules belong to a board: the default board uses top-level `automations`, other boards use `boards.<name>.automations`. Rules are **not inherited**; a board only runs its own.

```yaml
automations:
  - name: notify-done
    when:
      moved_to: done           # or created_in: <column> (exactly one)
      labels: [release, "!wip"]  # optional, all must match; ! negates
      props: { priority: high, team: "!ops" }  # optional, ! negates (also true when absent)
    run: echo {{ id }} {{ name }} >> done.log
    enabled: true              # optional, default true; false skips the rule
boards:
  another-board:
    columns: [backlog, active, shipped]
    automations:
      - name: ship
        when: { moved_to: shipped }
        run: ./deploy.sh {{ id }}
```

Triggers: `kb mv`, `kb set -s`, `kb add` (created in its status), and the web UI/API (drag, PATCH, create). Editing a file by hand or with `kb edit` triggers nothing.

### Template variables

`{{ id }}`, `{{ name }}`, `{{ body }}`, `{{ board }}`, `{{ status }}`, `{{ from }}` (empty on create), `{{ to }}`, `{{ path }}` (relative to the config dir), `{{ labels }}` (comma-joined), `{{ event }}` (`moved_to` or `created_in`), `{{ props.<key> }}` (empty if absent). Unknown variables are errors.

Every value is shell-quoted automatically (`'…'`). **Write placeholders bare — not inside quotes, backticks or heredocs.** `validate` and saving the config reject placeholders in those positions (`$( … )` is fine).

```sh
echo {{ name }} >> log.txt             # safe
git commit -m {{ name }}               # safe
echo "{{ name }}" >> log.txt           # rejected: inside "…"
echo `echo {{ name }}`                 # rejected: inside backticks
cat <<EOF
{{ body }}                             # rejected: inside heredoc
EOF
```

With bare placeholders, hostile ticket text (`'; rm -rf ~`) is passed as one literal argument. Inside quotes it would not be.

### Execution

- The rendered script is piped to `bash -s` stdin, with the config dir as cwd and `KB_AUTOMATION=1` added to the environment.
- 30 s timeout (the whole process group is killed). stdout/stderr are each capped at 64 KiB.
- Non-blocking: the move/add succeeds first and rules run in the background. A failing script never fails the command.
- CLI: the result is printed immediately, then `kb` waits for running scripts before exiting and prints `warning: automation "<name>" failed (…)` to stderr for failures. The web server is fully async; Ctrl-C kills running scripts.
- Several matching rules on one event all start together.

### Status in the ticket

Each run is recorded in the ticket's frontmatter, keyed by rule name:

```yaml
automations:
  notify-done:
    status: done         # running | done | failed
    at: "2025-06-01T14:32:05"
    exit: 0              # null if killed or not started
    error: "timeout after 30s"   # only on errors
```

`running` is written at start, then replaced by `done`/`failed` with the finish time.

### Loop guard

Scripts get `KB_AUTOMATION=1`, and `kb` run with that variable set (or with `--no-automation`) never triggers automations. So a script that calls `kb mv` cannot start a loop. There is no depth cap beyond this, and scripts that call the web API (`curl`) are **not** guarded.

### Log

`.kb/automation.log` (gitignored) holds one JSON line per finished run: board, rule, ticket id and path, event, rendered command, start/finish time, status and result (exit code, stdout, stderr, error). The command and each output are clipped to 4 KiB. Above 256 KiB the file is cut to the newest 200 lines. Test runs are not logged.

### Validation

`kb validate` (and saving the config) report as errors: empty or duplicate rule names, empty `run`, unknown template variables, placeholders inside quotes/backticks/heredocs, and a column that is not a column of the rule's board. A ticket whose rule has been `running` for more than 5 minutes (or with an unparseable time) gets a stale-run warning.

Renaming a column in Settings rewrites the rules that use it. Removing a column that a rule uses is blocked (the error names the rule).

### Settings → Automations

Settings has a rule card per board (default board and each override): name, enabled, event (moved to / created in) plus column, required labels, property filters (`!x` = not x), script, and a variable hint. **Test run** asks for confirmation and then *really executes* the script with a sample ticket (`POST /api/automation/test`). **Last automation runs** lists the last 20 runs; click a row for command, stdout and stderr.

### Disabling

`--no-automation` (global flag, or on `add`/`set`/`mv`/`web`) or `KB_AUTOMATION` in the environment turns it off. With `kb web --no-automation` rules never run, test runs return 503 and the UI shows the error.

### Security notes

- There is no auth by design. Anyone who can reach `kb web` can edit the config (Settings, or `PUT /api/config`) and so run commands as your user. Binding to a non-loopback host prints a warning (use `--no-automation` there).
- Hostile ticket text is safe only with bare placeholders (see above).
- Scripts that finish later rewrite the ticket's frontmatter, so the web UI may show the stale-edit banner if you had it open.

## Architecture

Three layers:

```
src/core/   UI-agnostic domain/service layer (Kanban API, config, tickets, frontmatter, parse helpers, KanbanError)
src/cli/    thin adapter: commander wiring, flag parsing, output formatting, stdin, $EDITOR, colour/TTY, exit codes
src/web/    second adapter over the core: http server, REST API, fs watcher + SSE, vanilla frontend in public/
src/runner.ts  bash AutomationRunner (timeout, output caps); outside core, which only knows the interface
src/automationLog.ts  .kb/automation.log writer/reader (rotation)
src/cli/automation.ts  CLI session: runner + log, waits for scripts, loop guard
src/web/public/automations.js  Settings → Automations builder
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
// automations only run when you pass a runner (they never run otherwise):
// createKanban({ dir, runner, automations: true, onAutomation: (rec) => log(rec) });
// await kb.settled(); // wait for in-flight automation runs
const { id, warnings } = kb.add({ name: "Fix login", labels: ["bug"], properties: { priority: "high" } });
kb.move(id, "doing");
kb.comment(id, "started");
const { boards } = kb.list({ labels: ["bug"], props: ["!priority:low"] });
const { errors } = kb.validate();
kb.fix({ dryRun: true }); // [{ path, from, to }]
const { config, mtime } = kb.getConfig();
kb.updateConfig({ ...config, columns: ["todo", "wip", "done"] }, { renames: { columns: { "": { doing: "wip" } } }, mtime });
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
- Comments inside the `automations:` list of `kanban.yaml` are not preserved when the list is saved from the UI.
- The Automations builder was only partly verified in a browser: rules inside board overrides, the failed-run display and the 503 display were not clicked.
- Web UI is not tested in real browsers beyond a headless Chrome smoke check (synthetic drag events).
- The create dialog and the Health fix buttons have not been exercised in a browser. The Settings config form was driven in headless Chrome (rename + confirm, blocked removal, external-change banner).
