# kb

<p align="center">
  <img src="kb_image.png" alt="kb screenshot" width="773">
</p>

A small, local, single-user kanban CLI: tickets are markdown files with YAML frontmatter, the board is `kanban.yaml`.

## What it is

- A local, single-user kanban for the terminal. Plain commands, output to stdout — no cloud, no sync, no accounts.
- Every ticket is a markdown file with YAML frontmatter. Readable, diffable, greppable, yours.
- A CLI (`kb`), an optional local web UI + HTTP API (`kb web`), and an MCP server (`kb mcp`) — all in this repo, on one core, with no services to run.
- TypeScript on Node 22+, ESM. Dependencies: `commander`, `yaml`, `zod` — that is all of them.

Four ways in, one board on disk:

| Surface  | Entry point                 | Needs                                      |
| -------- | --------------------------- | ------------------------------------------ |
| CLI      | `kb <command>`              | nothing; does not start a server           |
| HTTP API | `kb web` → `/api/*`, `/mcp` | a running `kb web` process                 |
| Web UI   | `kb web` → `/`              | the same process (static assets, built in) |
| MCP      | `kb mcp` (stdio)            | the client spawns it; nothing listens      |

MCP runs over two transports: stdio (`kb mcp`) and HTTP (`POST /mcp` on the same `kb web` process — stateless, no sessions, same tools). The HTTP transport is part of the HTTP API row, not a fifth surface. See [MCP](#mcp).

Plus a library export (`import { createKanban } from "kbkan"`), if you want to script against the same core.

## Install

Requires **Node 22+**.

From npm (once published):

```sh
npm install -g kbkan
```

From a GitHub release asset:

```sh
gh release download --repo hampusadamsson/kb --pattern 'kbkan-*.tgz'
npm install -g ./kbkan-<version>.tgz
```

From source:

```sh
git clone https://github.com/hampusadamsson/kb.git
cd kb
npm install
npm run build
npm link             # or: npm run install:local (build + link)
```

`npm link` puts `kb` on your `PATH` pointing at this checkout, so `npm run build` is enough to pick up changes. Remove it with `npm unlink -g kb`.

Verify with `kb --version`.

## Quick start

```sh
kb init                         # create kanban.yaml (columns todo, doing, done)
kb add "Fix login" -l bug       # create a ticket (first column)
kb ls --format text             # see the board
kb mv 1 doing                   # move a ticket to another column
kb show 1                       # read a ticket;  kb edit 1  to edit it in $EDITOR
kb web                          # open the board in your browser
```

## Ticket format

A ticket is a markdown file; the frontmatter is the data, the body is free markdown.

```markdown
---
type: ticket
id: "001" # only when ticketId: props (the default)
name: Fix login bug
status: todo
labels: [bug]
board: another-board # omitted on the default board
priority: high # non-reserved key: rendered as a key:value label
comments:
  2025-06-01T14:32: blocked on X
---

Free-form markdown body.
```

- `status` drives the column. Unknown or missing status lands the ticket in an `unsorted` group with a warning.
- **Where the id comes from** is set by `ticketId` in `kanban.yaml` — `props` (default) or `filename`. The two are mutually exclusive: whichever is configured wins and the other is ignored. See [Ticket ids](#ticket-ids).
- With `props`, ids are zero-padded strings in the frontmatter (`"001"`); `kb show 1` finds it. The filename is irrelevant for identity.
- With `filename`, the id is the file name without `.md` (`001-fix-login.md` → `001-fix-login`); a frontmatter `id:` is ignored.
- Files are never renamed, in either mode.
- Non-reserved keys (`priority`, anything else) are rendered as labels. Comments are a map keyed by local time.

## Ticket ids

```yaml
ticketId: props # default: the `id:` frontmatter key
# ticketId: filename      # the file name, without .md
```

| `ticketId` | id is                       | colliding ids | `kb fix`                        |
| ---------- | --------------------------- | ------------- | ------------------------------- |
| `props`    | `id:` in the frontmatter    | invalid       | writes a new `id:` into the file |
| `filename` | the file name, minus `.md`  | invalid       | can't (it never renames files)  |

Either way **an id must be unique**, and a collision is an error in `kb validate` — not something that is silently resolved. With `filename` ids this means two files named `001.md` in different directories collide even though the paths differ.

Switching modes does not rewrite anything: with `filename`, a `type: ticket` file whose stem is `007` is ticket `007` no matter what its frontmatter says, and a stale `id:` only earns a `validate` warning. Note that `kb add` writes no `id:` in this mode, and `kb fix` explains that renaming the file is the only way to change the id.

## Commands

| Command                 | What it does                                                      |
| ----------------------- | ----------------------------------------------------------------- |
| `kb init`               | Write a starter `kanban.yaml` here; refuses to overwrite.         |
| `kb add "Name"`         | Create a ticket in the first column (`-s`, `-l`, `-p`, `--body`). |
| `kb ls`                 | List tickets: JSON by default, `--format text` for the board.     |
| `kb show <id>`          | Print one ticket with properties, body and comments.              |
| `kb mv <id> <status>`   | Move a ticket to another column.                                  |
| `kb set <id>`           | Change fields: `-n`, `-s`, `-l`/`--unlabel`, `-p`/`--unset`.      |
| `kb comment <id> "…"`   | Append a timestamped comment.                                     |
| `kb edit <id>`          | Open the ticket file in `$EDITOR` (default `vi`).                 |
| `kb validate`           | Check config and tickets; exit code 1 on errors.                  |
| `kb fix`                | Give tickets a missing or duplicate id (`--dry-run` to preview).  |
| `kb boards`             | List the boards in use.                                           |
| `kb automations [kill]` | List live (or `--all`) automations; `kill` stops runs.            |
| `kb web`                | Start the local web UI and HTTP API (`--host`, `--port`, `--no-open`). |
| `kb mcp`                | Run kb as an MCP server on stdio for an editor or agent.          |
| `kb completion <shell>` | Print a completion script for bash or zsh.                        |

Ids accept a number: `7` matches `"007"`. With `ticketId: filename` the id is the file name minus `.md`, so pass e.g. `kb show 001-fix-login`. Use `kb <command> --help` for every flag.

## Configuration

`kanban.yaml` in the current directory (missing → run `kb init`).

```yaml
name: default
columns: [todo, doing, done]
glob: "*.md" # which files are scanned for tickets, relative to the config dir
ticketId: props # where ids come from: props (frontmatter `id:`) or filename
boards: {} # per-board column and automation overrides
tickets: {} # optional: which of the scanned files count as tickets (see below)
automations: [] # shell commands to run on moves/creates
```

See [`example/`](example/) for a working board with four columns and automations.

## Which files count as tickets

By default a file is a ticket when **both** are true:

1. it is inside `glob` (`*.md` = markdown in the config dir, not in subdirectories), and
2. its frontmatter says `type: ticket`.

```markdown
---
id: "001"
status: todo
type: ticket
---
Fix the login form.
```

`tickets:` lets you change that rule. It has three keys:

| key        | default | meaning                                                    |
| ---------- | ------- | ---------------------------------------------------------- |
| `baseline` | `true`  | keep the default rule above (`type: ticket` inside `glob`) |
| `include`  | `[]`    | extra rules: a match here is a ticket, `glob` or not       |
| `exclude`  | `[]`    | a match here is never a ticket; it beats everything else   |

Each rule is an object with at least one condition — `glob` (path), `prefix` (file-name start), `props` (frontmatter value equals, `!value` = is not), `has` (frontmatter key present, `!key` = absent). Conditions in one rule are ANDed; rules in a list are ORed.

Include rules that name a `glob` also **widen the scan** — that path is searched too, so subdirectories become reachable. Only `.md` files can be included.

### Examples

**Everything in `glob`, no `type: ticket` needed** — drop the baseline:

```yaml
tickets:
  baseline: false
  include:
    - glob: "*.md"
```

**All markdown, including subdirectories:**

```yaml
tickets:
  baseline: false
  include:
    - glob: "**/*.md" # any .md at any depth
```

This pulls in plain notes too, which then need an `id` and `status` — `kb validate` lists them and `kb fix` assigns ids. With `ticketId: filename` they need no `id:` at all (the file name is the id), only `status`.

**All markdown, except an archive folder:**

```yaml
tickets:
  baseline: false
  include:
    - glob: "**/*.md"
  exclude:
    - glob: "archive/**"
```

**Default rule, but also treat every `notes/*.md` as a ticket** (add `props: { type: ticket }` to keep requiring frontmatter):

```yaml
tickets:
  include:
    - glob: "notes/*.md"
```

**Only frontmatter-typed tickets, and never archived ones:**

```yaml
tickets:
  exclude:
    - props:
        archived: true # matches `archived: true`, not tickets without the key
```

**Ignore scratch files:** `test-*` notes that do not declare themselves tickets, and markdown with no frontmatter at all:

```yaml
tickets:
  exclude:
    - prefix: test
      props:
        type: "!ticket"
    - glob: "**/*.md"
      has:
        - "!type"
```

`node_modules/` and `.kb/` are always skipped. Check a change with `kb validate` or the Settings preview in `kb web`, which shows files gained and lost before saving.

## Automations

A rule runs a shell command when a ticket moves to (or is created in) a column, or on a cron schedule. Placeholders like `{{ id }}` or `{{ props.key }}` are shell-quoted for you — write them bare, never inside quotes.

```yaml
automations:
  - name: log-review
    when: { moved_to: review }
    run: echo {{ id }} {{ body }} >> review.log
  - name: review-pipeline
    when: { moved_to: review }
    run:
      - echo {{ id }} >> review.log
      - npm test
    continueOnError: false # default: a failing step stops the rest
```

`run` takes a single command or a list of steps run in order, one shell call each. A step that exits non-zero (or errors/times out) stops the sequence unless `continueOnError: true`; the run is recorded as failed at the first failing step, and the ticket keeps that step's exit code, error and `step:` number. The rule `timeout` applies per step.

Rules run in the background; at most 15 runs per ticket (loop guardrail, `guard: false` opts out); `--no-automation` disables them. See [`example/kanban.yaml`](example/kanban.yaml).

### Schedule trigger

`when: { schedule: "<5-field cron>" }` runs a rule on a timer. `in: <column>` is optional and limits it to tickets in that column; `labels` and `props` filters still apply.

```yaml
automations:
  - name: nag-review
    when: { schedule: "0 9 * * mon-fri", in: review } # weekdays 09:00
    run: echo {{ id }} still in review >> nag.log
```

- Fires once **per matching ticket** each time the cron matches; there is no ticket-less schedule.
- Runs **only while `kb web` or `kb mcp` is running** with automations enabled — not for plain CLI commands, and not with `--no-automation`. See [Where it runs](#where-it-runs).
- Uses the machine's local time, minute precision. Missed ticks are not caught up. A rule never fires twice in the same minute, and a ticket is skipped while the previous run of that rule on it is still running. DST: a repeated minute at fall-back fires once; minutes skipped at spring-forward are not caught up.
- The loop guard is **off** for scheduled rules; set `guard: true` to enable it.
- `{{ from }}` and `{{ to }}` are not available; `{{ event }}` is `schedule`.
- Cron: 5 fields (minute hour day-of-month month day-of-week) with `*`, lists, ranges, steps, month/day names; `7` is Sunday. If both day-of-month and day-of-week are restricted, either matching fires (OR). No seconds, no `@daily`-style macros. An invalid expression is reported by `kb validate`.

#### Quick start

1. Add the rule to `kanban.yaml` (as above).
2. `kb validate` — reports an invalid cron expression, or `{{ from }}`/`{{ to }}` in a schedule rule.
3. Start a scheduler process: `kb web --no-open` (or `kb mcp`).
4. At the next minute boundary that matches the cron (checked 0.25 s past the minute), one run starts per matching ticket. Check with `kb automations --all --format text` (see [Observing](#observing)).

With no ticket in the `in` column nothing happens, and that is not an error.

#### Where it runs

The scheduler is a timer inside the `kb web` or `kb mcp` process. Plain `kb` commands (`kb mv`, `kb ls`, …) never fire it, and it stops when the process exits. To keep it going, leave it running in a terminal or tmux, under a process supervisor, or in Docker. The image's default command is `kb web --host 0.0.0.0 --port 4747 --no-open`, so a running container is a running scheduler:

```sh
kb web --no-open                                    # local: leave it running
docker run -d -p 4747:4747 -v "$PWD/board:/data" kb  # container: scheduler included
```

- `--no-automation` (on `kb web` or `kb mcp`) does not start the scheduler.
- `kb mcp` over stdio lives only as long as the client keeps it spawned. `POST /mcp` is served by `kb web`, so it adds no second scheduler.
- Run **one** scheduler process per board. Each process dedupes same-minute firing only for itself, so two (`kb web` + `kb mcp`, two `kb web`s, two containers on one mounted board) fire every rule twice. The still-running check only mitigates this.
- Stopping `kb web` (Ctrl-C/SIGTERM) kills the runs it started.

#### Time zone

Cron uses the local time of the process: your system zone on your own machine. The Dockerfile sets no `TZ`, so a container uses its default zone (normally UTC). Check with `docker run --rm kb date` and write the cron expression in that zone.

#### Observing

Scheduled runs are recorded like any other automation run.

- **Ticket frontmatter**: an `automations:` entry per rule with `status` (`running`, `done`, `failed`, `skipped`), `at`, `exit` and, for failures, `error` and `step`.
- **CLI**: `kb automations` (same as `kb automations ls`) lists runs in progress right now; `kb automations --all` lists every rule with its last run and a running count. Output is JSON; add `--format text` for a table.
- **Web**: **Automations** shows each rule's last run, **Live** shows runs in progress (elapsed time, a Kill button), and **Logs** is the activity log, including `automation.finished` and `automation.skipped` events (e.g. reason `still-running`).
- **Files** in `.kb/`: `events.log` (what Logs shows; written by `kb web` and `kb mcp`) and `automation.log` (legacy; finished runs, written by `kb web` only).
- **Kill a run**: the Kill button in Live, or from any terminal `kb automations kill -t <id> -r <rule>` (`--dry-run` to preview, `-a` to kill every match).

#### Testing and disabling

To try a rule without waiting for the clock, open it in the web **Automations** view and press **Run test**. It really executes the command against a sample ticket with event `schedule`, shows the result, writes no log entry and touches no ticket. The same is available as `POST /api/automation/test`; it answers `503` under `--no-automation` and `429` while two tests are already running.

Deleting a rule in the web **Automations** view asks for confirmation first; after confirming, an **Undo** banner stays for 12 s.

To pause a rule, set `enabled: false`. A disabled scheduled rule is skipped before any ticket is scanned: nothing runs and nothing is recorded on tickets.

```yaml
- name: nag-review
  enabled: false
  when: { schedule: "0 9 * * mon-fri", in: review }
  run: echo {{ id }} still in review >> nag.log
```

#### Config edits

The scheduler's long-lived instance re-reads `kanban.yaml` and rescans tickets on every tick, so added, edited, disabled or removed rules apply at the next minute without a restart. A tick whose config fails to load does nothing (errors are swallowed), so run `kb validate` after editing by hand.

#### Troubleshooting

| Symptom                  | Check                                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing fires            | Is a `kb web`/`kb mcp` process running? Started with `--no-automation`?                                                                              |
| Nothing fires            | Wrong time zone: the process (e.g. a container in UTC) is not in the zone you wrote the cron for.                                                    |
| Nothing fires            | `kb validate`: an invalid cron expression is skipped silently at run time, and a config that fails to load stops every tick.                          |
| Nothing fires            | Rule has `enabled: false`? No ticket in the `in` column, or none matching `labels`/`props`? (Without `in`, tickets in any column match.)             |
| Fires on some tickets    | A ticket is skipped while the previous run of that rule on it is still running (`automation.skipped`, `still-running`). See Live or `kb automations`. |
| Fires twice              | Two scheduler processes on one board (see [Where it runs](#where-it-runs)).                                                                          |
| Missed while it was down | Not caught up: only the current minute is checked. Keep the process running.                                                                         |

## Web UI

- `kb web` — serves on `127.0.0.1:4747` (next free port if busy) and opens the browser.
- Defaults can live in `kanban.yaml`: `web: { host: 127.0.0.1, port: 4747 }`. Flags `--host`, `--port`, `--no-open` and `--no-automation` override config.
- Board tabs with columns from your config; drag a card to another column to change its status.
- Create and edit tickets, add comments, filter by text, labels and properties (URL-hash state).
- **Settings**: config editing, a visual automation builder, live runs, and the activity log.
- **Activity log**: an audit table of what changed and which automations ran.
- Live updates over SSE via a filesystem watcher — changes from the CLI show up immediately.
- **No auth.** Anyone who can reach the port can read and edit tickets. It is loopback-only by default; only bind `--host` to a network you trust.

## MCP

MCP is available over **two transports**, with one shared tool list. Either way it wraps the same core as the CLI and the web UI — same board, same config, same tickets — with no new dependencies.

| Transport | Entry point                        | Shape                                                     |
| --------- | ---------------------------------- | --------------------------------------------------------- |
| stdio     | `kb mcp`                           | the client spawns the process; nothing listens            |
| HTTP      | `POST /mcp` on the `kb web` server | stateless request/response; no sessions, no server stream |

### stdio

`kb mcp` runs kb as an MCP server over stdio, so an editor or agent can read and change tickets.

```json
{
  "mcpServers": {
    "kb": { "command": "kb", "args": ["mcp", "--dir", "/path/to/board"] }
  }
}
```

### HTTP

`POST /mcp` on the same port as `kb web`. Stateless: no sessions, no `Mcp-Session-Id`, no server-initiated stream, nothing to keep between requests. One JSON-RPC message or a batch array per request; a notification — or a batch of only notifications — gets `202` with an empty body, and `GET`/`DELETE /mcp` get `405`. The board is the one `kb web` is serving, so there is no `--dir` here.

```sh
kb web --no-open --port 4747 &
curl -s -X POST localhost:4747/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
curl -s -X POST localhost:4747/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

An HTTP entry for a client config (field names differ per client — some use `transport` instead of `type`):

```json
{
  "mcpServers": {
    "kb": { "type": "http", "url": "http://127.0.0.1:4747/mcp" }
  }
}
```

### Tools

Both transports expose the same list.

| Tool             | What it does                                                                        |
| ---------------- | ----------------------------------------------------------------------------------- |
| `kb_boards`      | List boards and their columns (no tickets).                                         |
| `kb_search`      | Search tickets by text, board, label or property; summaries only, no bodies.        |
| `kb_read`        | Read one ticket: frontmatter, body, comments and automation status.                 |
| `kb_create`      | Create a ticket.                                                                    |
| `kb_update`      | Change name, status, board, labels, properties or body, or append a comment.        |
| `kb_move`        | Move a ticket to another column (sets status only).                                 |
| `kb_comment`     | Append a comment to a ticket.                                                       |
| `kb_validate`    | Check `kanban.yaml` and every ticket; reports errors and warnings.                  |
| `kb_fix`         | Repair missing or duplicate ids; dry-run unless you ask it to write.                |
| `kb_automations` | List automation runs currently in progress.                                         |

- **Same tools on both transports**, wired the same way; a tool call gets a fresh board view either way.
- `/mcp` takes the same write guards as `/api/*`: a JSON `Content-Type` and a same-origin `Origin`. No auth, so anyone who can reach the port can read and edit tickets — same rule as the web UI.
- `--dir` picks the board directory for `kb mcp` (default: the current directory). A missing `kanban.yaml` fails at startup rather than on the first tool call; over HTTP it is the board `kb web` was started on, and a missing config fails `kb web`.
- Automations are fire-and-forget: a write returns before its rule finishes — check `kb_read` or `kb_automations` for the result.
- `kb_fix` defaults to dry-run, so nothing is written until you pass `dryRun: false`.

## HTTP API

`kb web` serves a JSON API on the same port as the UI. It is not a separate daemon: **there is no API unless `kb web` is running.** No auth — loopback by default, so anyone who can reach the port can read and edit tickets.

All routes are under `/api`. Errors are `{ "error": "…", "code": "…" }` with a status from `not-found`→404, `ambiguous`/`exists`/`stale`→409, `invalid`/`parse`→400, `config`→500; unexpected throws are redacted to `500 {"error":"internal error"}`.

| Method | Path                            | What it does                                                               |
| ------ | ------------------------------- | -------------------------------------------------------------------------- |
| `GET`  | `/api/health`                   | `{"ok":true,"version":"…"}`; liveness probe, loads no config               |
| `GET`  | `/api/board`                    | Board view; query `board`, `text`, `label`, `property` (repeatable, `!` negates) |
| `POST` | `/api/tickets`                  | Create a ticket (`name` required; `status`, `board`, `labels`, `properties`, `body`, `comment`, `file`, `id`) |
| `GET`  | `/api/tickets/:id`              | One ticket: frontmatter, body, comments, automation status                 |
| `PATCH`| `/api/tickets/:id`              | Update fields; send `mtime` to get `409 stale` on a concurrent edit        |
| `POST` | `/api/tickets/:id/comments`     | Append a comment (`text`, optional `mtime`)                                |
| `GET`  | `/api/validate`                 | Errors and warnings for config and tickets                                 |
| `POST` | `/api/fix`                      | Repair ids; `dryRun` defaults to **true**                                  |
| `GET`  | `/api/config`                   | Editable `kanban.yaml` view plus its `mtime`                               |
| `PUT`  | `/api/config`                   | Replace config; `renames`, `mtime`, `dryRun`                               |
| `POST` | `/api/config/preview-tickets`   | How proposed `tickets:` rules change the set                               |
| `GET`  | `/api/events`                   | Audit log; `q`, `type`, `ticket`, `board`, `source`, `before`, `limit`     |
| `GET`  | `/api/automation/log`           | Legacy: last 20 finished runs                                              |
| `POST` | `/api/automation/test`          | Render and run a rule against a sample ticket                              |
| `GET`  | `/api/automation/runs`          | Runs in progress, including other processes'                               |
| `POST` | `/api/automation/runs/:id/kill` | Kill a run (202 accepted)                                                  |

`GET /api/health` is the liveness probe: it touches no config and no tickets, so polling it is cheap and it answers even while the board is mid-edit. The Docker `HEALTHCHECK` and the Kubernetes probes use it.

Writes (anything but `GET`/`HEAD`) need `Content-Type: application/json`, a same-origin `Origin`, and `Sec-Fetch-Site: same-origin`/`none`; otherwise `415` or `403`. Request bodies are capped at 1 MB (`413`).

`GET /api/stream` is a separate SSE endpoint on the same server: it emits `event: changed` when a ticket or config file changes and `event: runs` when the set of running automations changes. It is how the UI stays live when you edit a ticket from the CLI.

```sh
kb web --no-open --port 4747 &
curl -s localhost:4747/api/board?label=bug
curl -s -X POST localhost:4747/api/tickets \
  -H 'Content-Type: application/json' -d '{"name":"Fix login","labels":["bug"]}'
```

## Library

The package also exports its core, so a script can use the same code path as the CLI and web UI:

```ts
import { createKanban } from "kbkan";

const kb = createKanban({ dir: "/path/to/board" });
for (const b of kb.list().boards) console.log(b.name, b.columns.length);
```

Pass `runner` only if you want automations to execute; without it the core reads and writes tickets but never runs a command, which is what makes it safe to embed.

## Docker

The image runs `kb web` and nothing else: no Node install on the host, no global link.

```sh
mkdir -p board
chmod 0777 board                                 # the container runs as uid 10001
docker run --rm -v "$PWD/board:/data" kb kb init  # write a starter kanban.yaml
docker run -d --name kb -p 4747:4747 -v "$PWD/board:/data" kb
```

- Build it with `docker build -t kb .` from the repo root.
- **`/data` is the board directory**, not scratch space: `kanban.yaml`, the ticket `.md` files, and `.kb/` (event and automation logs, created on demand) all live there. Mount a directory that already has `kanban.yaml` — `kb web` refuses to start without one; `kb init` writes the starter one.
- The process runs as **uid 10001** (unprivileged, user `kb`), so the mounted directory must be writable by it: `chmod 0777 board`, `chown -R 10001 board`, or run with `--user "$(id -u):$(id -g)"`. A host dir owned by root and not writable by 10001 fails with `EACCES` on `kanban.yaml`.
- Port **4747**, fixed by the entry point's `--host 0.0.0.0 --port 4747 --no-open` flags — `--host 0.0.0.0` because loopback is unreachable through a published port, and `--port` beats `web.port` in `kanban.yaml`.
- Health: `GET /api/health`, used by the image's `HEALTHCHECK`; `docker inspect --format '{{.State.Health.Status}}' <container>` reports it.
- The CLI is on `PATH` inside the container, so `docker exec <container> kb ls` works against the same board.

Published image: `ghcr.io/hampusadamsson/kb`, tagged `sha-<7>` (short commit) and `latest`. The two point at the same digest.

```sh
docker run -d --name kb -p 4747:4747 -v "$PWD/board:/data" ghcr.io/hampusadamsson/kb:latest
```

**Kubernetes:** put the board on a PVC mounted at `/data` — the tickets need a writable volume, not an image layer — and keep `kanban.yaml` in a ConfigMap, mounted at `/data/kanban.yaml` via `subPath` so it lands as a file beside the tickets instead of replacing the directory. `subPath` mounts are not updated when the ConfigMap changes; restart the pod to pick up an edit. A ConfigMap volume is read-only, so the Settings config editor cannot save `kanban.yaml` — edit the ConfigMap instead. The volume must be writable by uid 10001, and the usual pod-level `fsGroup: 10001` does **not** solve that here: with a hostPath-based provisioner (e.g. `local-path`) the kubelet cannot apply fsGroup ownership to the volume, so the setting is silently ignored while looking like a fix. Use a root init container that `chown -R 10001:10001 /data` with the same PVC mounted at `/data`, then run the app container as 10001. Point both probes at `/api/health`.

```yaml
spec:
  # chown the volume once per pod start, then drop back to 10001 for the app.
  initContainers:
    - name: fix-data-ownership
      image: ghcr.io/hampusadamsson/kb:latest
      command: ["sh", "-c", "chown -R 10001:10001 /data"]
      securityContext: { runAsUser: 0, runAsGroup: 0 }
      volumeMounts:
        - { name: board, mountPath: /data }
  containers:
    - name: kb
      image: ghcr.io/hampusadamsson/kb:latest
      ports: [{ containerPort: 4747 }]
      volumeMounts:
        - { name: board, mountPath: /data }
        - { name: config, mountPath: /data/kanban.yaml, subPath: kanban.yaml }
      livenessProbe: { httpGet: { path: /api/health, port: 4747 } }
      readinessProbe: { httpGet: { path: /api/health, port: 4747 } }
  volumes:
    - name: board
      persistentVolumeClaim: { claimName: kb-board }
    - name: config
      configMap: { name: kb-config }
```

## Development

```sh
npm install          # also installs the git hooks (husky)
npm run dev          # tsc --watch
npm run verify       # format:check + lint + typecheck + build + test
```

| Script               | What it does                                     |
| -------------------- | ------------------------------------------------ |
| `npm run verify`     | Full gate; run this before pushing.              |
| `npm test`           | Vitest suite (`test:watch` for watch mode).      |
| `npm run typecheck`  | `tsc --noEmit` over `src` and `test`.            |
| `npm run lint`       | oxlint (`lint:fix` to autofix).                  |
| `npm run format`     | Prettier write (`format:check` to verify only).  |
| `npm run build`      | `tsc` plus a copy of `src/web/public` → `dist`.  |
| `npm run pack:smoke` | Packs the tarball and runs `kb` from a temp dir. |

Husky hooks: **pre-commit** runs `lint-staged` (oxlint `--fix` + Prettier on staged files), **pre-push** runs the typecheck and the tests related to your changes. Commit messages follow Conventional Commits — see [`AGENTS.md`](AGENTS.md).

## Docs / more detail

- `kb --help` and `kb <command> --help` — everyday usage, flags and examples.
- [`example/`](example/) — a sample board with tickets and automations.
- [`AGENTS.md`](AGENTS.md) — commit conventions and repo rules.
- The activity-log event reference and internal architecture are documented in the source under `src/` (`src/api/api.ts` is the HTTP router, `src/mcp/protocol.ts` the MCP transport).
