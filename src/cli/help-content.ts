import type { Command } from "commander";
import { addExamples, addSection, type HelpCommand } from "./help.js";

type Section = [title: string, text: string | string[]];
interface Content {
  sections?: Section[];
  examples: string[];
}

const ROOT_DESC = "Local markdown kanban CLI. Tickets are plain .md files; the board is kanban.yaml.";

const AUTO = "Board automations may run on this change; see README. --no-automation skips them.";

const ROOT: Content = {
  sections: [
    ["Environment", [
      "EDITOR         editor for 'kb edit' and '--edit' (default: vi)",
      "NO_COLOR       disable colored output",
      "KB_AUTOMATION  set by automation scripts; disables automations (like --no-automation)",
    ]],
  ],
  examples: [
    "kb add \"Fix login bug\" -l bug -p priority:high",
    "kb ls -l bug --format text",
    "kb mv 1 doing",
  ],
};

const GETTING_STARTED: string[] = [
  "1. kb init                         create kanban.yaml (columns todo, doing, done)",
  "2. kb add \"Fix login\" -l bug       create a ticket (first column)",
  "3. kb ls --format text             see the board",
  "4. kb mv 1 doing                   move a ticket to another column",
  "5. kb show 1                       read a ticket;  kb edit 1  to edit it in $EDITOR",
  "6. kb web                          open the board in your browser",
];

const TICKETS: string[] = [
  "A ticket is a .md file: YAML frontmatter (name, status, labels, properties) + a body.",
  "Ids look like 001; a number matches too (7 matches 007).",
  "The status is the column the ticket is in (see columns in kanban.yaml).",
];

const ROOT_LEARN_MORE = [
  "  Use 'kb <command> --help' for details. Configuration (columns, boards, automations) is",
  "  documented in the README; see example/ in the repo for a sample board.",
];

const COMMANDS: Record<string, Content> = {
  init: {
    sections: [["Notes", "Writes a starter kanban.yaml here; refuses to overwrite an existing one."]],
    examples: ["kb init", "kb init && kb add \"First ticket\""],
  },
  ls: {
    sections: [
      ["Filters", [
        "Filters combine (AND). Put ! in front to negate; use single quotes in the shell.",
        "",
        "kb ls login             text appears anywhere in the ticket",
        "kb ls -l bug            has label bug          (-l '!bug': does not have it)",
        "kb ls -p priority:high  property equals value  (-p priority: property is set)",
        "kb ls -p '!status:done' property is not that value",
      ]],
      ["Output", [
        "JSON by default (for scripts); --format text shows the board for humans.",
        "At most 50 tickets are listed; --limit 0 lists all. -b picks one board.",
      ]],
    ],
    examples: [
      "kb ls --format text",
      "kb ls -l bug -p priority:high",
      "kb ls -p '!status:done' --format text",
      "kb ls login",
      "kb ls --full -l bug",
      "kb ls --limit 0",
      "kb ls -b another-board --format text",
    ],
  },
  boards: {
    sections: [["Notes", "Lists the boards in use."]],
    examples: ["kb boards", "kb ls -b another-board"],
  },
  show: {
    sections: [["Notes", "Prints the ticket's properties, body and comments."]],
    examples: ["kb show 1", "kb show 001", "kb show ABC-1"],
  },
  add: {
    sections: [["Notes", [
      "- The new ticket goes in the first column unless you pass -s.",
      "- --body - reads the body from stdin; -e opens the new ticket in $EDITOR.",
      "- Prints '#<id> <path>'.",
      AUTO,
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
      "- Only the given fields change; give at least one.",
      "- -l adds labels, --unlabel removes them; -p sets properties, --unset removes them.",
      AUTO,
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
      "- Same as 'kb set <id> -s <status>'. An unknown column warns and uses 'unsorted'.",
      AUTO,
    ]]],
    examples: ["kb mv 1 doing", "kb mv 007 done", "kb mv 1 done --no-automation"],
  },
  edit: {
    sections: [["Notes", "Opens the ticket file in $EDITOR (default vi), e.g. EDITOR=\"code -w\"."]],
    examples: ["kb edit 1", "EDITOR=nano kb edit 1", "EDITOR=\"code -w\" kb edit 1"],
  },
  comment: {
    sections: [["Notes", "Appends a timestamped comment to the ticket."]],
    examples: ["kb comment 1 \"blocked on X\"", "kb comment 1 \"unblocked, retrying\""],
  },
  fix: {
    sections: [["Notes", "Gives tickets with a missing or duplicate id a new id; files are not renamed. Use --dry-run to preview."]],
    examples: ["kb fix --dry-run", "kb fix"],
  },
  validate: {
    sections: [["Notes", "Checks kanban.yaml and all tickets for problems. Exit code 1 if errors were found, else 0."]],
    examples: ["kb validate", "kb validate && echo ok"],
  },
  automations: {
    sections: [["Notes", [
      "- Read-only: shows what is running now (default) or every configured automation.",
      "- JSON by default (for scripts); --format text prints a table. -b picks one board.",
      "- Setup of automations is documented in the README (Automations).",
    ]]],
    examples: ["kb automations", "kb automations --all --format text", "kb automations -b another-board --all"],
  },
  web: {
    sections: [["Notes", [
      "- Run in the folder with kanban.yaml. Prints 'kb web running at <url>' and opens it.",
      "- Default port is 4747 (next free one if busy). Press Ctrl-C to stop.",
      "- There is no login: only bind --host to networks you trust.",
      AUTO,
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
  addSection(program, "Getting started", GETTING_STARTED, true);
  addSection(program, "Tickets", TICKETS, true);
  (program as HelpCommand).learnMore = ROOT_LEARN_MORE;
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
