import type { Command } from "commander";
import { addExamples, addSection } from "./help.js";

type Section = [title: string, text: string | string[]];
interface Content {
  sections?: Section[];
  examples: string[];
}

const ROOT_DESC = `Local markdown kanban CLI.

Tickets are markdown files with YAML frontmatter; boards and columns come from kanban.yaml.`;

const ROOT: Content = {
  sections: [
    ["Environment", [
      "KB_AUTOMATION  set inside automation scripts; any value disables automations",
      "               for kb add/set/mv (same as --no-automation)",
      "EDITOR         editor for 'kb edit' and '--edit' (default: vi; VISUAL is ignored)",
      "NO_COLOR       disable colored output",
    ]],
  ],
  examples: [
    "kb add \"Fix login bug\" -l bug -p priority:high",
    "kb ls -l bug --format text",
    "kb mv 1 doing",
  ],
};

const COMMANDS: Record<string, Content> = {
  init: {
    sections: [["Notes", "Writes a starter kanban.yaml in the current directory and refuses to overwrite an existing one."]],
    examples: ["kb init", "kb init && kb add \"First ticket\""],
  },
  ls: {
    sections: [
      ["Filters", [
        "All filters are ANDed. Prefix a value with ! to negate it; quote it with single",
        "quotes so the shell leaves the ! alone.",
        "",
        "[text]                 case-insensitive substring of the whole file",
        "-l bug                 has label bug",
        "-l '!bug'              does not have label bug",
        "-p priority:high       property equals value (any element for lists)",
        "-p priority            property exists",
        "-p '!priority:low'     not equal to low (also true when absent)",
        "-p '!priority'         property is absent",
        "'!wip'                 text does not contain wip",
      ]],
      ["Output", [
        "Default is JSON: {total, shown, limit, truncated, tickets[]}. total counts matches",
        "before the limit. Each ticket has id, name, board, status, column, labels, props",
        "and path. --full also adds body and comments.",
        "",
        "--limit defaults to 50; 0 means all. When the list is cut, a warning goes to",
        "stderr (stdout stays valid JSON) and truncated is true. Other warnings go to",
        "stderr too.",
        "",
        "--format text prints the board view for humans (ignores --full and --limit).",
        "-b limits output to a single board.",
      ]],
    ],
    examples: [
      "kb ls",
      "kb ls -l bug -p priority:high",
      "kb ls -p '!status:done'",
      "kb ls login",
      "kb ls --full -l bug",
      "kb ls --limit 0",
      "kb ls -b another-board --format text",
    ],
  },
  boards: {
    sections: [["Notes", "Lists configured boards plus boards discovered on tickets."]],
    examples: ["kb boards", "kb ls -b another-board"],
  },
  show: {
    sections: [["Notes", "Prints properties, body and comments. Duplicate ids are an error listing the files; run 'kb fix'."]],
    examples: ["kb show 1", "kb show 001", "kb show ABC-1"],
  },
  add: {
    sections: [["Notes", [
      "- The id is the next padded id (max numeric + 1, e.g. 004); --id sets it explicitly.",
      "- Status defaults to the first column of the board (-s to choose).",
      "- --body - reads the body from stdin.",
      "- The file is created as <id>-<slug>.md in the config dir; -f <path> picks another",
      "  path (inside the config dir, ending in .md; it must match the glob in",
      "  kanban.yaml, default *.md, or the ticket is not listed).",
      "- -p key:value cannot set reserved keys (type, id, name, status, board, labels,",
      "  comments, automations); use the dedicated flags.",
      "- -e opens the new file in $EDITOR afterwards.",
      "- Automations fire for the created ticket (created_in its column) unless",
      "  --no-automation or KB_AUTOMATION is set.",
      "- Prints '#<id> <path>'.",
    ]]],
    examples: [
      "kb add \"Fix login bug\" -l bug -p priority:high",
      "kb add -n \"Write docs\" -s doing -b another-board --body \"see wiki\"",
      "echo \"long body\" | kb add \"From stdin\" --body -",
      "kb add \"Custom\" -f custom.md --id ABC-1 -c \"created by hand\"",
      "kb add \"Needs details\" -e",
    ],
  },
  set: {
    sections: [["Notes", [
      "- Only the given fields change; at least one change is required.",
      "- -l adds labels, --unlabel removes them; -p sets properties, --unset removes them.",
      "- Reserved keys (type, id, name, status, board, labels, comments, automations)",
      "  cannot be set with -p or removed with --unset; use the dedicated flags.",
      "- Changing status fires moved_to automations (like 'kb mv').",
    ]]],
    examples: [
      "kb set 1 -p priority:low -l urgent",
      "kb set 1 --unset priority --unlabel bug",
      "kb set 1 -n \"Fix login redirect bug\"",
      "kb set 1 -s done -c \"shipped\"",
    ],
  },
  mv: {
    sections: [["Notes", [
      "- Same as 'kb set <id> -s <status>'.",
      "- An unknown column puts the ticket in unsorted, with a warning on stderr.",
      "- Fires moved_to automations for the target column. The CLI waits for the scripts",
      "  to finish before exiting, unless --no-automation (or KB_AUTOMATION) is set.",
    ]]],
    examples: ["kb mv 1 doing", "kb mv 007 done", "kb mv 1 done --no-automation"],
  },
  edit: {
    sections: [["Notes", [
      "Opens the ticket file in $EDITOR (default vi; $VISUAL is ignored). The command runs",
      "through the shell, so EDITOR=\"code -w\" works. Editing by hand triggers no automations.",
    ]]],
    examples: ["kb edit 1", "EDITOR=nano kb edit 1", "EDITOR=\"code -w\" kb edit 1"],
  },
  comment: {
    sections: [["Notes", [
      "Appends a comment to the ticket's comments map. Keys are local timestamps to the",
      "minute (2025-06-01T14:32); on a collision seconds are added.",
    ]]],
    examples: ["kb comment 1 \"blocked on X\"", "kb comment 1 \"unblocked, retrying\""],
  },
  fix: {
    sections: [["Notes", [
      "Repairs ticket ids and prints each change; files are never renamed.",
      "- Missing id: taken from a numeric filename prefix (042-foo.md -> 042) if free,",
      "  else the next padded id.",
      "- Duplicate ids: the oldest file (mtime, then path) keeps the id; others get new ids.",
      "Use --dry-run to preview without writing.",
    ]]],
    examples: ["kb fix --dry-run", "kb fix"],
  },
  validate: {
    sections: [["Notes", [
      "Checks the config and schema, automation rules (names, run, template variables and",
      "quoting, columns), frontmatter parse errors, missing and duplicate ids, missing or",
      "unknown status, labels/comments types, and automations stuck in running.",
      "Undeclared boards and stuck automations are warnings only.",
      "Exit code is 1 if there are errors, otherwise 0.",
    ]]],
    examples: ["kb validate", "kb validate && echo ok"],
  },
  web: {
    sections: [["Notes", [
      "- Needs kanban.yaml in the current directory. Prints 'kb web running at <url>'.",
      "- --port defaults to 4747 and auto-increments if busy; an explicit --port is strict.",
      "- The Settings page edits kanban.yaml (columns, boards, automations) and shows health.",
      "- There is no auth. Do not bind to a non-loopback --host on networks you do not trust.",
      "- Automation values are shell-quoted: write {{ name }} bare, not inside quotes.",
      "- --no-automation: rules never run from the UI.",
    ]]],
    examples: ["kb web", "kb web --port 8080 --no-open", "kb web --no-automation"],
  },
  completion: {
    sections: [["Install", [
      "zsh (needs: autoload -U compinit && compinit):",
      "  source <(kb completion zsh)",
      "  persist: echo 'source <(kb completion zsh)' >> ~/.zshrc",
      "",
      "bash:",
      "  source <(kb completion bash)",
      "  persist: echo 'source <(kb completion bash)' >> ~/.bashrc",
      "  or: kb completion bash > /etc/bash_completion.d/kb",
    ]]],
    examples: ["kb completion zsh", "kb completion bash > /etc/bash_completion.d/kb"],
  },
};

/** Attach descriptions, sections and examples to commands, looked up by name. */
export function applyHelpContent(program: Command): void {
  program.description(ROOT_DESC);
  const apply = (cmd: Command, c: Content): void => {
    for (const [t, text] of c.sections ?? []) addSection(cmd, t, text);
    addExamples(cmd, c.examples);
  };
  apply(program, ROOT);
  for (const cmd of program.commands) {
    const c = COMMANDS[cmd.name()];
    if (c) apply(cmd, c);
  }
}
