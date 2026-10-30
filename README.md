# kb

A small, local, single-user CLI kanban. Tickets are markdown files with YAML frontmatter.

- CLI plus an optional local web UI (`kb web`). No auth (see [security model](#security-model)), no TUI. Plain commands, output to stdout.
- Stack: TypeScript, Node 22+, ESM.
  - `commander` — CLI
  - `yaml` — parsing; the Document API is used for rewrites so formatting and comments from hand edits are preserved
  - `zod` — config validation
  - `vitest` — tests
  - `tsc` — build
  - Web UI: Node built-in `http` and a vanilla JS frontend — no extra dependencies, no build step for the frontend
- Binary name: `kb`. Installed via `npm link`.

`kb --help` covers everyday use; this README covers configuration and advanced features (columns, boards, [automations](#automations), the [activity log](#activity-log-audit-events), the [REST API](#rest-api)). See [`example/`](example/) for a sample board with automations.

## Install

Requires Node 22+.

```sh
npm install && npm run build && npm link
```

## Quick start

Same steps as `kb --help` → GETTING STARTED:

```sh
kb init                         # create kanban.yaml (columns todo, doing, done)
kb add "Fix login" -l bug       # create a ticket (first column)
kb ls --format text             # see the board
kb mv 1 doing                   # move a ticket to another column
kb show 1                       # read a ticket;  kb edit 1  to edit it in $EDITOR
kb web                          # open the board in your browser
```

## Development

```sh
npm run build && npm test
```

`npm run build` runs `tsc` and copies `src/web/public` to `dist/web/public`. The e2e web tests need a built `dist`, so run the build before the tests.

## Everyday CLI usage

### Commands

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
| `kb automations [--live\|--all] [-b board] [--format text]` | Running automations (default) or all configured ones; read-only |
| `kb web [--host <addr>] [--port <n>] [--no-open] [--no-automation]` | Start the local web UI |
| `kb completion <bash\|zsh>` | Print a shell completion script (see [Shell completion](#shell-completion)) |
| `kb help [command]` | Help about any command (same as `kb <command> --help`) |

Global flag `--no-automation` (also accepted after `add`, `set`, `mv`, `web`) skips [automations](#automations).

#### init

Writes a starter `kanban.yaml`; refuses if one exists.

```sh
kb init
```

#### ls

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

#### boards

```sh
kb boards
```

#### add

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

#### set

Same flags as `add` (except `-f` and `--id`), plus:

- `--unset key` (repeatable)
- `--unlabel x` (repeatable)
- `--reset-automations` (delete the ticket's automation run history, which resets the [loop guardrail](#loop-guardrail) counter; triggers nothing)

Refuses to change `id` or reserved `type`.

```sh
kb set 1 -p priority:low -l urgent
kb set 1 --unset priority --unlabel bug
kb set 1 -n "Fix login redirect bug"
```

#### mv

```sh
kb mv 1 doing
```

#### show

```sh
kb show 1
```

#### edit

Uses `$EDITOR` only (`VISUAL` is ignored), default `vi`. Run via shell, so `EDITOR="code -w"` works.

```sh
kb edit 1
```

#### comment

```sh
kb comment 1 "blocked on X"
```

#### fix

For `type: ticket` files without an id: assign id from numeric filename prefix (`042-foo.md` → `"042"`, prefix kept as-is) if present and free, else the next padded id. Processing order: mtime, then path. Also repairs duplicate ids: the oldest (mtime, then path) keeps it; others get next free padded ids. New ids are max numeric + 1, skipping ids already used (including ones assigned in the same run). Never renames files. Prints each change.

```sh
kb fix --dry-run
kb fix
```

#### validate

Checks: config parse + schema, automation rules (see [Automations](#validation)), frontmatter parse errors, missing id, duplicate ids, missing/unknown status, board not declared in `boards:` (warning only), automation stuck in `running` for over 5 minutes (warning), `labels` not a list, `comments` not a map. Exit 0 if no errors, 1 if errors; warnings do not affect the exit code. Duplicate ids produce one error line per file.

```sh
kb validate
```

#### web

Starts the local web UI for the board in the current directory (needs `kanban.yaml`). See [Web UI](#web-ui-kb-web).

```sh
kb web
kb web --port 8080 --no-open
kb web --host 0.0.0.0
```


### Help

`kb --help` shows the basics: GETTING STARTED, TICKETS, MAIN/OTHER COMMANDS, FLAGS, ENVIRONMENT, EXAMPLES. `kb help <cmd>` and `kb <cmd> --help` show USAGE / ARGUMENTS / FLAGS / NOTES / EXAMPLES in a jira-cli-like layout. Color is used only on a TTY (and not with `NO_COLOR`).

The help deliberately covers basic use only. Configuration (columns, boards, automations) is documented here; the help points to this README and to `example/`.

### Shell completion

`kb completion <shell>` prints a completion script for `zsh` or `bash`.

**zsh** — add to `~/.zshrc`, after `autoload -U compinit && compinit`:

```sh
source <(kb completion zsh)
```

**bash** — either source it from `~/.bashrc`:

```sh
source <(kb completion bash)
```

or write it to a file in the bash-completion directory:

```sh
kb completion bash > /etc/bash_completion.d/kb
kb completion bash > "$(brew --prefix)/etc/bash_completion.d/kb"   # Homebrew
```

What is completed:

- Commands (with descriptions in zsh) and each command's options.
- Ticket ids for `show`, `set`, `mv`, `edit`, `comment` (with ticket names in zsh).
- Columns: for `kb mv <id> <status>` the columns of that ticket's board; for `-s/--status` the columns of all boards.
- Boards (`--board`), labels (`--label`, `--unlabel`), property keys (`--property`, `--unset`; inserted as `key:`).
- `--format` values (`json`, `text`) and the shells for `kb completion`.

The scripts are generated from the commander definition, so commands and options cannot drift from the CLI. Dynamic values come from a hidden helper, `kb __complete <kind>` (`ids`, `columns`, `boards`, `labels`, `propkeys`). It is silent on errors (prints nothing, no stderr output) and never runs automations.

Limitation: the scripts were checked only by generating, sourcing and syntax-checking them. Live TAB behaviour in an interactive shell was not tested by the agents.


## Ticket format

By default a ticket is any markdown file matched by `glob` whose YAML frontmatter has `type: ticket`. What counts as a ticket is configurable with the `tickets` key (see [Configuration](#configuration-kanbanyaml)): files can be opted in without `type: ticket`, or opted out. Other files (notes without frontmatter, templates like `type: {{ type }}`, invalid YAML) are ignored silently, and `kb` never prints YAML library warnings. A file with unparseable frontmatter is only reported (as a parse error, also by `kb validate`) if its frontmatter has a line `type: ticket`. Flat directory by default.

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
- **name**: title stored as `name:`; body is free markdown. A ticket without `name` (possible for files opted in by `tickets.include`) shows its filename without extension.
- **Included files**: a file matched by an include rule is a ticket even without `type`, `id`, `name`, `status` or frontmatter (missing status → unsorted warning, missing id → warning; `kb fix` assigns ids). `mv`/`set` create the frontmatter if needed and never add `type: ticket`. `kb add` always writes `type: ticket`, and warns (`not-scanned`) when `-f` points outside what `glob`/`tickets` scan.
- **status**: decides the column. Missing, or not a column of the ticket's board → shown in the "unsorted" group with a warning. Files are never auto-edited (except via fix/write commands).
- **board**: optional. Absent = default board. Written only when not default. Boards are discovered from tickets.
- **labels**: list property, rendered as `[x]` tags. All other non-reserved properties are rendered automatically as `key:value` labels.
- **comments**: map keyed by local time ISO to the minute, e.g. `2025-06-01T14:32: blocked on X`. On collision within the same minute, seconds are used (`2025-06-01T14:32:05`); if that also collides, seconds are added until a free key is found.

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

## Configuration (kanban.yaml)

File: `./kanban.yaml`, read from the current working directory only. If missing, `kb` errors with a hint to run `kb init` (which writes `name`, `columns: [todo, doing, done]` and `glob`).

| Key | Meaning |
|---|---|
| `name` | Optional, default `"default"`. Name of the default board (tickets without `board:`). |
| `columns` | Required, non-empty, ordered as listed. |
| `glob` | Optional, default `"*.md"`, e.g. `"**/*.md"`; relative to the config dir. `node_modules` is always excluded. |
| `tickets` | Optional, what counts as a ticket: `baseline`, `include`, `exclude` rules. See [Ticket rules](#ticket-rules). |
| `boards.<name>.columns` | Optional per-board column override. Boards not listed use the top-level `columns`. |
| `automations` | Optional rules for the default board, see [Automations](#automations). |
| `boards.<name>.automations` | Optional rules for that board. Not inherited from the default board. |

The sample board in [`example/`](example/) (a `kanban.yaml` plus ~20 tickets) uses all of the above except `boards:`:

```yaml
name: default
columns: [todo, doing, review, done]
glob: "*.md"
automations:
  - name: log-review
    when:
      moved_to: review
    run: echo {{ id }} {{ body }} >> test.txt
  - name: followup-on-done
    when:
      moved_to: done
    run: sleep 15 && kb add "ABC"{{ id }} -s todo
  - name: pi
    when:
      moved_to: done
    run: pi --role researcher -p "check kb cli for operation. your task is to interact with a board kb. read "{{ body }}" and create a ticket in todo with a summary of this topic from the web."
    enabled: false
```

- The board is called `default`, has four columns (`review` is the extra one) and picks up every `*.md` in the folder.
- `log-review` and `followup-on-done` are explained in [the example rules](#the-example-rules). `pi` is disabled with `enabled: false` (the rule is kept but skipped). Its prompt closes the quote before `{{ body }}` and reopens it after, so the placeholder is bare and passes validation. `pi` is a local agent CLI, not part of kb.
- The tickets (`001-dummy123.md` …) are ordinary tickets. Those that have run rules carry an `automations:` block recording each run (see [Status in the ticket](#status-in-the-ticket)); `test.txt` is the file `log-review` appends to.
- To try it: `cd example && kb ls --format text`, `kb validate`, `kb web`. Moving a ticket to `review` appends to `test.txt`.

A board override with its own columns and rules looks like this:

```yaml
boards:
  another-board:
    columns: [backlog, active, shipped]
    automations: []
```

### Ticket rules

```yaml
glob: "*.md"                    # files scanned by default
tickets:
  baseline: true                # default true: `type: ticket` (within glob) counts; false → only include rules count
  include:                      # a file matching ANY include rule is a ticket (even without type: ticket)
    - name: tasks-folder        # optional label, used in messages
      glob: "tasks/**/*.md"     # path glob relative to the kanban dir; may reach outside the top-level glob
      prefix: "T-"              # file name (basename) starts with
      props: { kind: task }     # frontmatter equals (string compare like `kb ls -p`; list = any element); "!value" negates
      has: [status]             # keys that must exist ("!key" = must NOT exist)
  exclude:                      # a file matching ANY exclude rule is never a ticket
    - glob: "templates/**"
    - prefix: "_"
    - props: { type: daily }
```

- Within one rule all given conditions must match (AND); a rule needs at least one condition. Across rules it is OR.
- A file is a ticket iff it is not excluded AND ((`baseline` AND `type: ticket` AND inside the top-level `glob`) OR it matches an include rule). **Exclude wins** over include and baseline.
- Include rule `glob`s add their files to the scan. An include rule without `glob` only applies to files inside the top-level `glob`. Only `.md` files are ever tickets; `node_modules` and `.kb` are always excluded.
- Globs are relative to the kanban dir: absolute paths and `..` are rejected; `prefix` is a file name prefix and must not contain `/`.
- Files with unparseable frontmatter are reported as parse errors only if they are tickets by rules that need no parsing (an include rule with only `glob`/`prefix`, or a `type: ticket` line within `glob`); `props`/`has` rules cannot be evaluated for them, so they are skipped silently. Files excluded by path/prefix are silent.
- `kb validate`: invalid globs are errors; duplicate rule names and `baseline: false` without include rules are warnings.
- Saving via the settings API (`PUT /api/config`, `tickets` field) rewrites only the `tickets` key (comments elsewhere kept; the key is removed when it equals the default). A dry run also returns `ticketScope: {gained, lost}`; `POST /api/config/preview-tickets` with `{tickets}` returns `{total, newlyIncluded, newlyExcluded, unchanged, gained, lost}` (path lists capped at 50) without writing anything.

### Validation rules

Config problems are errors (`kb validate`, and the Settings save is refused with nothing written):

- invalid YAML or schema (`columns` missing or empty, wrong types);
- `columns` empty or duplicate, empty column name, empty board name, empty `name` or `glob` (Settings save);
- automation rules: see [Automations → Validation](#validation).

A board that exists only on tickets and not in `boards:` is a warning, not an error; it uses the default columns.

### Editing in Settings → Config

The web UI edits `kanban.yaml` for you (your YAML comments and unrelated keys are kept, except comments inside `automations:`): default board name, `glob`, ordered columns (rename inline, reorder, add, remove) and per-board column overrides. Details under [Web UI → Settings](#settings). Automations are edited in the Automations tab of the same dialog.

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
    guard: true                # optional, default true; false opts out of the loop guardrail
    timeout: 30                # optional seconds (0..86400); absent or 0 = no timeout
boards:
  another-board:
    columns: [backlog, active, shipped]
    automations:
      - name: ship
        when: { moved_to: shipped }
        run: ./deploy.sh {{ id }}
```

| Field | Meaning |
|---|---|
| `name` | Required, unique per board. Also the key in the ticket's `automations:` block. |
| `when` | Exactly one of `moved_to` / `created_in` (a column of the board), plus optional `labels` and `props` filters. |
| `run` | Shell script, rendered from the [template](#template-variables) and run with `bash -s`. |
| `enabled` | Default `true`. With `false` the rule never runs; an `automation.skipped` event (`reason: rule-disabled`) is logged. |
| `guard` | Default `true`. See [Loop guardrail](#loop-guardrail). |
| `timeout` | Whole seconds, `0`–`86400`. Default `0` = no timeout (an absent key means the same; `0` is never written back to the file). Per rule, per board, not inherited. Negative, fractional or non-numeric values are rejected. |

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
- **No timeout by default**: a script runs until it finishes or is killed (Live tab **Kill**, or `kb web` shutdown). Set `timeout: <seconds>` on a rule to limit it: on expiry the process group gets SIGTERM, SIGKILL after 2 s, and the run is `status: failed`, `exit: null`, `error: "timed out after Ns"`; its `automation.finished` event has `timedOut: true` and `timeoutSeconds`. stdout/stderr are each capped at 64 KiB.
- Non-blocking: the move/add succeeds first and rules run in the background. A failing script never fails the command.
- CLI: the result is printed immediately, then `kb` waits for running scripts before exiting (a rule with `sleep 15` keeps the command open for 15 s) and prints `warning: automation "<name>" failed (…)` to stderr for failures. The web server is fully async; Ctrl-C kills running scripts.
- Several matching rules on one event all start together.
- Scripts inherit your environment, so anything they call (such as `kb`) must be on `PATH`.

### Status in the ticket

Each run is recorded in the ticket's frontmatter, keyed by rule name:

```yaml
automations:
  notify-done:
    status: done         # running | done | failed | skipped
    at: "2025-06-01T14:32:05"
    exit: 0              # null if killed or not started
    runs: 3              # runs of this rule on this ticket (guardrail counter)
    error: "timed out after 30s"   # only on errors
  ship:
    status: skipped
    at: "2025-06-01T14:40:00"
    reason: "guardrail: 15 automation runs on this ticket"   # only on skipped
    runs: 2
```

`running` is written at start (and increments `runs`), then replaced by `done`/`failed` with the finish time; `runs` is carried over. `skipped` (with `reason`) is written only by the guardrail. Entries without `runs` (older tickets) count as 1.

### Loop guardrail

A rule can retrigger itself indirectly (a script that moves a ticket through the web API, or two rules that move a ticket back and forth). To stop runaway loops, a ticket gets at most `AUTOMATION_RUN_LIMIT` = **15** automation runs in total: the sum of `runs` over all entries of its `automations:` map, plus runs started in the same dispatch.

- At the limit, further matching rules do not run. Their entry gets `status: skipped` and a `reason`, and an `automation.skipped` event (`reason: guardrail`, with `runs` and `limit`) is logged. The CLI prints no warning for this.
- Opt out per rule with `guard: false` (or untick *Stop after 15 runs per ticket* in Settings → Automations). The limit itself is not configurable.
- Reset the counter by deleting the ticket's run history: **Reset automation history** in the ticket dialog, `kb set <id> --reset-automations`, or `PATCH /api/tickets/:id` with `{ "resetAutomations": true }`. A reset emits `ticket.automations-reset` and never triggers automations.

### Loop protection

Two layers:

1. Scripts get `KB_AUTOMATION=1`, and `kb` run with that variable set (or with `--no-automation`) never triggers automations. So a script that calls `kb mv` cannot start a loop.
2. The guardrail above. It also covers what the variable does not: scripts that call the web API (`curl`) are not blocked by `KB_AUTOMATION`, but still hit the run limit.

There is no depth cap beyond this.

### Listing automations

`kb automations` shows what is running right now (`--live`, default); `kb automations --all` lists every configured rule with its `timeout` (seconds, 0 = none; a TIMEOUT column in text), last run and counts (JSON by default, `--format text` for a table, `-b` for one board). It is derived from the tickets' `automations` frontmatter, so scripts started by `kb web` or by the CLI both show up; entries `running` for more than 5 minutes count as stale (not live; status `stale` in `--all`). It never runs anything or writes files. `--live` items carry `timeoutSeconds` (0 = none). The Live tab in the web UI shows the server's own runs and can kill them.

### Validation

`kb validate` (and saving the config) report as errors: empty or duplicate rule names, empty `run`, an invalid `timeout` (negative, fractional, not a number, above 86400), unknown template variables, placeholders inside quotes/backticks/heredocs, and a column that is not a column of the rule's board. A ticket whose rule has been `running` for more than 5 minutes (or with an unparseable time) gets a stale-run warning.

Renaming a column in Settings rewrites the rules that use it. Removing a column that a rule uses is blocked (the error names the rule).

### The example rules

[`example/kanban.yaml`](example/kanban.yaml) has two live rules and one disabled one:

- **`log-review`**: when a ticket is moved to `review`, appends `<id> <body>` to `test.txt` in the config dir (`echo {{ id }} {{ body }} >> test.txt`). Check with `cat example/test.txt`.
- **`followup-on-done`**: when a ticket is moved to `done`, waits 15 s, then runs `kb add "ABC"{{ id }} -s todo`, creating a ticket named `ABC<id>` in `todo` (the quotes around `ABC` are outside the placeholder, so the id stays bare). That is why the example has many `ABC0xx` tickets. Because of the `sleep`, `kb mv` stays open for 15 s when run from the CLI; the web UI does not wait. The inner `kb add` runs with `KB_AUTOMATION=1`, so it triggers no rules. `kb` must be on `PATH`.
- **`pi`**: disabled (`enabled: false`); an example of calling an external agent CLI.

### Settings → Automations

The tab has a board switcher (one button per board with its rule count; rules apply only to the selected board, they are not inherited; order does not matter, every matching rule runs), a collapsible *How automations work* note, and **Add automation**. With six or more rules a filter box appears. Each rule is a collapsible card: an *Enabled* switch, name, a one-line summary (*When a ticket moves to review · labels: bug · runs echo …*), a last-run chip (done/failed/running/skipped + relative time, from the tickets' run history; *disabled*, *never run*, *not saved yet*), **Duplicate** and **Delete**. Delete removes the card at once and offers **Undo** for 12 s; nothing is written until *Save config*. Enter/Space on the header expands the card (`aria-expanded`); new and duplicated rules open with focus in the name, and rules with problems show a red `!` and open with inline errors tied to the fields. The body has *When* (event, column, required labels, property filters; `!x` = not x), *Run* (auto-growing script, variable chips that insert `{{ id }}` etc. at the cursor, a rendered preview with sample values, quoting hint), *Options* (loop guard checkbox *Stop after 15 runs per ticket*; *Timeout (seconds)*, integer 0–86400, empty/0 = none, shown in the summary as `timeout 30s`; Test run uses the field value) and *Test run*: pick the sample ticket or a real ticket of the board, **Run test** (asks for confirmation, then *really executes* the script with that ticket's values, `POST /api/automation/test`; not logged, touches no ticket) shows pass/fail, exit code, duration and output. An empty board offers two starter templates (*moves to a column*, *is created in a column*) that prefill a rule. Run history is in [Settings → Logs](#settings--logs) (filter *Automations*).

### Disabling

`--no-automation` (global flag, or on `add`/`set`/`mv`/`web`) or `KB_AUTOMATION` in the environment turns it off. With `kb web --no-automation` rules never run, test runs return 503 and the UI shows the error. Matching rules skipped because automations are off are logged as `automation.skipped` (`reason: automations-off`).

### Security notes

- There is no auth by design. Anyone who can reach `kb web` can edit the config (Settings, or `PUT /api/config`) and so run commands as your user. Binding to a non-loopback host prints a warning (use `--no-automation` there).
- Rules run with your user's permissions and environment. Review a `kanban.yaml` from someone else before running `kb` on it, as you would a Makefile.

## Activity log (audit events)

Every real change made through `kb` or `kb web` is appended as one JSON line to `.kb/events.log` (the `.kb/` folder is gitignored). Logging errors are ignored, so they never fail a command.

- **Rotation**: when the file exceeds 5 MB it is renamed to `events.1.log` (replacing the previous one); one old file is kept.
- **Line size**: a line is at most 8000 characters. Larger events keep their metadata with clipped `summary`/`ticketName`/`path` and `data: { "truncated": true }`. Text in `data` (comments, commands) is clipped to 200 characters.
- **Reading**: queries read both files whole (up to ~10 MB), skip corrupt lines and sort by event id.

Example line:

```json
{"id":"0mvv3udks-001fxy","ts":"2026-10-30T16:06:10.108+01:00","type":"ticket.moved","source":"cli","board":"default","ticketId":"001","ticketName":"A","path":"001-a.md","summary":"#001 moved todo → doing","data":{"from":"todo","to":"doing"}}
```

### Fields

| Field | Meaning |
|---|---|
| `id` | Unique and sortable: time (base36) + counter + random suffix. Newest = largest; also the paging cursor. |
| `ts` | Local time, ISO 8601 with offset and milliseconds. |
| `type` | See below. |
| `source` | `cli`, `web`, `automation` (a `kb` run inside an automation script, i.e. `KB_AUTOMATION` set) or `unknown` (library use without a source). |
| `board`, `ticketId`, `ticketName`, `path` | Present on ticket events. |
| `summary` | Human one-liner. |
| `data` | Type-specific, see below. |

### Event types

| Type | When | `data` |
|---|---|---|
| `ticket.created` | add | `status`, `board`, `labels`, `props`, `hasBody`, `hasComment` |
| `ticket.moved` | status changed | `from` (null if none), `to` |
| `ticket.renamed` | name changed | `from`, `to` |
| `ticket.labels` | labels added/removed | `added`, `removed` |
| `ticket.props` | properties set/unset | `set`, `unset`, `old` |
| `ticket.body` | body changed | `changed`, `fromLength`, `toLength` |
| `ticket.board` | board changed | `from`, `to` |
| `ticket.comment` | comment added | `text` (clipped); `key` when added with `kb comment` |
| `ticket.automations-reset` | run history cleared | `hadHistory` |
| `ids.fixed` | `kb fix` / Health fix wrote changes | `changes: [{ path, from, to }]` |
| `config.updated` | a config change was saved | diff of `columns`, `boards`, `automations` (added/removed/renamed/changed), `ticketsMigrated`, `tickets` (first 50 edits) |
| `automation.started` | a rule started | `rule`, `event` |
| `automation.finished` | a rule ended | `rule`, `status` (`done`/`failed`), `exit`, `durationMs`, `command` (clipped), `error?`, `killed?`, `timedOut?` + `timeoutSeconds?` (when the rule's timeout expired) |
| `automation.skipped` | a matching rule did not run | `rule`, `reason` (`rule-disabled`, `automations-off`, `guardrail`), `event`; guardrail adds `runs`, `limit` |

One `set`/PATCH that changes several things emits one event per kind of change.

**Not logged**: no-op changes (same status/name/labels/props/body), `--dry-run` / `dryRun` previews, config saves that change nothing, automation status writes to the ticket frontmatter, Test runs, and hand edits of files.

### Settings → Logs

The **Logs** tab shows a table, newest first: Time (relative; absolute on hover), Event (coloured pill; orange for skipped), Ticket (click to open; greyed if it no longer exists), Board, Source, Summary. Click a row (or press Enter/Space) to expand id, timestamp, path and all `data`.

- Search box (debounced): case-insensitive substring over summary, type, ticket id and name, board and `data`.
- Filters: event type (All, Ticket changes, Moves, Labels, Properties, Comments, Config, Automations, Fix ids), source (cli/web/automation), and board (when there is more than one).
- Pagination: 50 per page; **Load more** fetches older events; **Newest** reloads from the top once more than 50 are loaded.
- Live: while the tab is open, new events are prepended if you are at the top of the unfiltered list; otherwise a *New events — refresh* pill appears.

The same data is available from `GET /api/events` (see [REST API](#rest-api)).

### Settings → Live

The **Live** tab lists automation runs in progress in this `kb web` server (rule runs and Test runs). The tab shows `Live (n)` and a pulsing yellow dot (also on the Settings button) while something runs. Each row shows rule (or *Test run*), board, ticket link (opens the ticket), start time, ticking elapsed `mm:ss`, a timeout progress bar (or *no timeout* when the rule has none), the command, and an expandable tail (~2 KB) of stdout/stderr. **Kill** asks for confirmation, then sends SIGTERM to the process group and SIGKILL after 2 s. A killed rule run is written to the ticket as `status: failed`, `exit: null`, `error: killed by user`, and its `automation.finished` event has `error: "killed by user"` and `killed: true`. Finished runs are in Logs. With `--no-automation` the tab says automations are disabled.

- `GET /api/automation/runs` → `{ runs }` newest first (`runId, kind: rule|test, board?, rule?, ticketId?, ticketName?, path?, command, pid, startedAt, timeoutMs (null = no timeout), elapsedMs, output`); disabled → `{ runs: [], disabled: true }`.
- `POST /api/automation/runs/:id/kill` → 202 `{ ok: true }`; unknown/finished id → 404 `not-found`. Same-origin guards apply.
- SSE `runs` event on `/api/stream` when a run starts, finishes or is killed (`changed` is unaffected). The open tab also polls every 2 s for the output tail.

### Legacy automation log

`.kb/automation.log` and `GET /api/automation/log` (last 20 finished runs, newest first) are still written and served for backward compatibility; the UI no longer uses them. `automation.finished` events carry the same run info (command, exit, duration) but not stdout/stderr.

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
- **Automation status dots**: tickets with `automations:` run status in frontmatter show one small dot per automation on the card (worst first: failed, running, skipped, done, unknown; wraps onto a second line when many) plus the names of running rules (`running: pi, followup`). The detail dialog has an *Automations* section (rule, status word, relative time, exit code, error) and a **Reset automation history** button (clears the run history and so the [guardrail](#loop-guardrail) counter; not shown for read-only tickets). Legend: green = done, yellow (pulsing) = running, red = failed (failed status, non-zero exit or error), orange = skipped (guardrail), grey = unknown. Each dot has a tooltip/aria-label; updates arrive live, and an open dialog only refreshes that section (your edits are kept, no "changed on disk" banner).
- Filter bar: text, labels, properties, with `!` negation as in `kb ls`. State lives in the URL hash: `#board=..&text=..&l=..&p=..`.
- <a id="settings"></a>**Settings** (header button, badge = issue count) is a dialog with four tabs (arrow keys switch, `Home`/`End` jump): **Config**, **Automations**, **Live**, **Logs**. Config and Automations share one form state (one dirty state; a • marks tabs with unsaved changes). The Config tab title shows the issue count (red badge when there are errors). A footer bar is always visible: issue summary on the left ("2 errors, 1 warning", click to jump to Health), then **Fix ids…** (Config only; disabled when nothing to fix), **Revert**, **Save config**, **Close** (asks to discard unsaved changes). Live and Logs have only Close.
  - **What is a ticket?** section (Config tab, below the board overrides): edits the `tickets` rules ([Ticket rules](#ticket-rules)). A checkbox for the `type: ticket` baseline (a warning shows when nothing can count as a ticket), and an *include* and an *exclude* list of rule cards (optional name, folder glob, filename prefix, property conditions where `!value` negates, has-property chips where `!key` means must not exist) with a one-line summary each. *Quick add* presets (folder, property, prefix; templates folder, daily notes, files starting with `_`) add a prefilled rule. A live preview (400 ms debounce, `POST /api/config/preview-tickets`) shows how many files become or stop being tickets with expandable path lists (max 50) before you save. Every rule needs at least one condition (checked client side too). When a save changes which files are tickets, the confirm box shows `N files will become tickets / M will stop being tickets`.
  - **Automations** tab: one section per board (default + overrides) with the rule builder (see [Settings → Automations](#settings--automations)). Automation validation errors are prefixed `Automations:`.
  - *Config* tab: form for `kanban.yaml`: default board name, `glob`, ordered columns (rename inline, reorder, add, remove), and per-board column overrides (add, rename, remove). Saving keeps your YAML comments and unrelated keys.
  - Renaming a column rewrites `status` on every ticket using it; renaming a board rewrites an explicit `board:`. Before anything is written the UI shows how many ticket files will change (dry run) and asks to confirm.
  - Removing a column is **blocked** while tickets still use it (the error lists them). Removing a board override is allowed; its tickets fall back to the default columns. Unsorted tickets never block.
  - Invalid configs (empty/duplicate columns, empty name or glob) are refused and nothing is written. If `kanban.yaml` changes on disk while the form is open, a banner offers **Reload** (and **Overwrite** after a stale save).
  - *Live* tab: automation runs currently in progress, see [Settings → Live](#settings--live). Tab order: Config / Automations / Live / Logs.
  - *Health* (bottom of the Config tab): `validate` results and board warnings ("No issues found." when clean); **Fix ids…** shows a dry-run preview there before Apply. Parse errors are shown only here.
  - *Logs* tab: the audit event table, see [Settings → Logs](#settings--logs). Automation run history lives here (filter *Automations*); the old *Last runs* list is gone.
- Tickets with duplicate ids or no id are read-only and carry badges (use `fix`).
- Stale-edit banner: edits send the ticket's mtime; if the file changed on disk the UI offers **Reload** or **Overwrite**.
- Not available in the UI: `init` and `edit`.

### Mobile / touch

The UI works on phones (360–430 px), landscape and small tablets; desktop layout is unchanged.

- **Breakpoints**: `max-width: 640px` (phone layout), `max-width: 640px` or `max-height: 500px` (full-screen dialogs, also phone landscape), and `pointer: coarse` (bigger touch targets on any touch device, e.g. tablets).
- **Board**: columns form a horizontal scroll-snap strip (~85 vw each). Header tabs scroll sideways; the filter bar collapses behind a **Filters** button (badge = active filters). The header is not sticky on phones.
- **Move control**: on touch devices each card has a native **Move to…** select that moves the card with the same code path as drag and drop (same board only; hidden for read-only cards). On desktop it is hidden but reachable with the keyboard (Tab to the card, then the select). Drag and drop is unchanged on desktop; HTML5 drag does not work on touch, hence the select.
- **Dialogs** (ticket, create, Settings) are full-screen sheets on narrow screens: sticky header with a large close button, sticky footer with safe-area padding, scrollable body, no page scroll behind. Settings tabs scroll horizontally; the Logs table becomes stacked rows (time + event, then ticket, then summary; tap to expand).
- Inputs are 16 px (no iOS zoom on focus), interactive targets are at least 44 px, long paths/commands wrap, animations respect `prefers-reduced-motion`, `viewport-fit=cover` + `env(safe-area-inset-*)` handle notches.

### Live updates

- `fs.watch` (recursive) on the board dir, filtered by `glob`; `kanban.yaml` changes count too. `node_modules`, `dist` and `.git` are ignored.
- Debounced 100 ms, with a 1 s max-wait. Events go out over SSE (`GET /api/stream`); the UI refetches on every event.
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
| `PATCH /api/tickets/:id` | Core patch fields (`name`, `status`, `board`, `addLabels`, `removeLabels`, `setProps`, `unsetProps`, `body`, `comment`), `resetAutomations: true` (clears the ticket's automation run history), plus optional `mtime`; stale → 409 `code: "stale"` with `currentMtime` |
| `POST /api/tickets` | Create (201) |
| `POST /api/tickets/:id/comments` | Add comment, body `{ text, mtime? }` (201) |
| `GET /api/validate` | Validation result |
| `POST /api/fix` | Body `{ dryRun }`, default `true` |
| `GET /api/config` | `{ config: {name, columns, glob, boards}, mtime }` |
| `PUT /api/config` | Body `{ config, renames?, mtime?, dryRun? }` → `{ dryRun, changes, configChanged, mtime }`. `renames` is `{ columns: { "": {old: new}, <board>: {old: new} }, boards: {old: new} }`. `dryRun` (only when exactly `true`) reports ticket edits without writing. Stale `mtime` → 409 `code: "stale"`; invalid config or a column still in use → 400 `invalid` |
| `POST /api/automation/test` | Render and really run a script with a sample ticket (see [Automations](#automations)) |
| `GET /api/automation/log` | Legacy: `{ runs }`, the last 20 automation runs, newest first |
| `GET /api/events` | Audit events (query below) |
| `GET /api/stream` | SSE stream (`changed` and `runs` events; was `/api/events`) |
| `GET /api/automation/runs` | Automation runs in progress (Live tab) |
| `POST /api/automation/runs/:id/kill` | Kill a running automation (202; 404 if not running) |

`GET /api/events` query (all optional): `q` (substring search), `type` (event type; repeat the param or comma-separate; a trailing `.*` matches a prefix, e.g. `ticket.*`), `ticket` (ticket id), `board`, `source` (`cli`/`web`/`automation`), `before` (event id cursor: only older events), `limit` (integer 1..200, default 50; otherwise 400 `invalid`). Returns `{ events, nextCursor? }`, newest first; pass `nextCursor` as `before` for the next page. See [Activity log](#activity-log-audit-events).

`/api/automation/test` body: `{ run, event?: "moved_to"|"created_in", board?, timeout?: seconds (0–86400, default none), sample?: { id, name, body, status, from, to, labels, props } }` → `{ command, result: { exitCode, stdout, stderr, error? } }`. Unknown variable or bad placeholder position → 400 `invalid`; automations disabled → 503 `disabled`; more than 2 test runs in flight → 429 `busy`. Test runs are not logged and touch no ticket.

Status mapping: `not-found` 404; `ambiguous`, `exists`, `stale` 409; `invalid`, `parse` 400; `unsupported` 415; host not allowed 421; `config` 500; body too large (1 MB) 413.

### Frontend

`src/web/public/`: vanilla ES modules, no build step, no dependencies. `index.html`, `style.css`, `app.js` (wiring), `api.js`, `board.js`, `dialog.js`, `filters.js`, `settings.js`, `settings-tabs.js`, `automations.js`, `logs.js`, `logs-logic.js`, `status.js`, `dom.js`, and `logic.js` (pure logic, unit-tested). See [Architecture](#architecture) for what each does.

## Architecture

Three layers:

```
src/core/   UI-agnostic domain/service layer (Kanban API, config, tickets, frontmatter, parse helpers, KanbanError)
src/cli/    thin adapter: commander wiring, flag parsing, output formatting, stdin, $EDITOR, colour/TTY, exit codes
src/web/    second adapter over the core: http server, REST API, fs watcher + SSE, vanilla frontend in public/
src/runner.ts  bash AutomationRunner (optional per-run timeout, output caps); outside core, which only knows the interface
src/automationLog.ts  legacy .kb/automation.log writer/reader (rotation)
src/eventLog.ts  .kb/events.log writer/query (rotation, line clipping)
src/core/events.ts  audit event model, id/timestamp helpers, config diff (core only emits to an injected sink)
src/cli/automation.ts  CLI session: runner + logs, waits for scripts, KB_AUTOMATION gate, event source (cli/automation)
src/cli/help.ts, help-content.ts  help layout renderer and per-command help text (USAGE/ARGUMENTS/FLAGS/NOTES/EXAMPLES)
src/cli/completion.ts, completion-model.ts, completion-zsh.ts, completion-bash.ts  completion scripts generated from the commander program
src/cli/commands/complete.ts  candidates for the hidden `kb __complete` helper
src/web/public/automations.js  Settings → Automations builder (incl. Test run, guard checkbox)
src/web/public/logs.js, logs-logic.js  Settings → Logs table and its pure helpers
src/web/public/settings.js, settings-tabs.js  Settings dialog and its accessible tab strip
src/web/public/ticket-rules.js, ticket-rules-logic.js  Settings → Config "What is a ticket?" editor and its pure helpers
src/web/public/status.js  automation status dots, card indicator, ticket-dialog Automations section
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
- **Help = basics, README = advanced** — `kb --help` stays short (getting started, commands); configuration and automations are documented here, and the help links to this README and `example/`.
- **Audit log in `.kb/events.log`, emitted from core** — core only talks to an injected `EventSink`; the CLI/web adapters pick the sink and `source`. JSON lines, one old file kept, no database.
- **Loop guardrail counts runs in the ticket** — the counter lives in the ticket's `automations:` map, so it survives restarts and can be reset by deleting it.
- **Dropped gray-matter** — a single YAML parser for read and write avoids divergent date/type parsing.

## Status

Implemented: v1, the web UI (`kb web`), automations with the loop guardrail, the activity log and the Logs tab. All commands working; vitest suite passing.

### Known limitations

- Rewrites preserve YAML comments, key order and body, but whitespace inside frontmatter is normalised by the yaml library (e.g. `key:   value` → `key: value`).
- `mv`/`set` to a status not in the board's columns only warns (ticket lands in unsorted).
- `node_modules` is always excluded from the glob scan.
- Comments inside the `automations:` list of `kanban.yaml` are not preserved when the list is saved from the UI.
- The guardrail limit (15) is a constant, not configurable.
- `GET /api/events` reads the whole log (and `events.1.log`, so up to ~10 MB) per request and filters in memory; fine for a local tool, not for huge logs.
- Event ids are time-based per machine; clock changes can make ordering odd.
- Browser verification is limited. Automated: vitest (API, e2e web server tests) and a headless Chrome smoke check (synthetic drag events); the Settings config form was driven in headless Chrome (rename + confirm, blocked removal, external-change banner). Mobile layout was verified with Chrome device emulation (390x844, 360x640, 844x390, 768x1024, touch events) but **not** on real phones. **Not** verified in a real browser: rules inside board overrides, the failed-run and 503 displays, the create dialog and the Health fix buttons.
- Logs tab, guard checkbox, skipped dots and Reset were exercised in headless Chrome (synthetic CDP input), not in a real desktop browser.
- Shell completion: live TAB behaviour in an interactive zsh/bash was not tested (only generation, sourcing and syntax).
