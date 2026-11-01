# kb

<p align="center">
  <img src="kb_image.png" alt="kb screenshot" width="773">
</p>

A small, local, single-user kanban CLI: tickets are markdown files with YAML frontmatter, the board is `kanban.yaml`.

## What it is

- A local, single-user kanban for the terminal. Plain commands, output to stdout — no cloud, no sync, no accounts.
- Every ticket is a markdown file with YAML frontmatter. Readable, diffable, greppable, yours.
- A CLI (`kb`) plus an optional local web UI: `kb web` serves the board on `127.0.0.1`.
- TypeScript on Node 22+, ESM. Dependencies: `commander`, `yaml`, `zod`.

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
id: "001"
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
- `id` lives in the frontmatter, not the filename. Ids are zero-padded strings (`"001"`); `kb show 1` finds it.
- The filename is irrelevant for identity. Files are never renamed.
- Non-reserved keys (`priority`, anything else) are rendered as labels. Comments are a map keyed by local time.

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
| `kb web`                | Start the local web UI (`--host`, `--port`, `--no-open`).         |
| `kb mcp`                | Run kb as an MCP server on stdio for an editor or agent.          |
| `kb completion <shell>` | Print a completion script for bash or zsh.                        |

Ids accept a number: `7` matches `"007"`. Use `kb <command> --help` for every flag.

## Configuration

`kanban.yaml` in the current directory (missing → run `kb init`).

```yaml
name: default
columns: [todo, doing, done]
glob: "*.md" # which files are scanned, relative to the config dir
boards: {} # per-board column and automation overrides
tickets: {} # what counts as a ticket: baseline, include, exclude rules
automations: [] # shell commands to run on moves/creates
```

See [`example/`](example/) for a working board with four columns and automations.

## Automations

A rule runs a shell command when a ticket moves to (or is created in) a column. Placeholders like `{{ id }}` or `{{ props.key }}` are shell-quoted for you — write them bare, never inside quotes.

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

`kb mcp` runs kb as an MCP server over stdio, so an editor or agent can read and change tickets. It wraps the same core as the CLI and the web UI — same board, same config, same tickets — with no new dependencies.

```json
{
  "mcpServers": {
    "kb": { "command": "kb", "args": ["mcp", "--dir", "/path/to/board"] }
  }
}
```

| Tool             | What it does                                                                        |
| ---------------  | ----------------------------------------------------------------------------------- |
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

- **Stdio only.** The client spawns the process; nothing listens on a port and stdout carries only JSON-RPC.
- `--dir` picks the board directory (default: the current directory). A missing `kanban.yaml` fails at startup rather than on the first tool call.
- Automations are fire-and-forget: a write returns before its rule finishes — check `kb_read` or `kb_automations` for the result.
- `kb_fix` defaults to dry-run, so nothing is written until you pass `dryRun: false`.

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
- The REST API, activity-log event reference and internal architecture are documented in the source under `src/`.
