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
    [
      "Environment",
      [
        "EDITOR         editor for 'kb edit' and '--edit' (default: vi)",
        "NO_COLOR       disable colored output",
        "KB_AUTOMATION  set by automation scripts; disables automations (like --no-automation)",
      ],
    ],
  ],
  examples: ['kb add "Fix login bug" -l bug -p priority:high', "kb ls -l bug --format text", "kb mv 1 doing"],
};

const GETTING_STARTED: string[] = [
  "1. kb init                         create kanban.yaml (columns todo, doing, done)",
  '2. kb add "Fix login" -l bug       create a ticket (first column)',
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
    examples: ["kb init", 'kb init && kb add "First ticket"'],
  },
  ls: {
    sections: [
      [
        "Filters",
        [
          "Filters combine (AND). Put ! in front to negate; use single quotes in the shell.",
          "",
          "kb ls login             text appears anywhere in the ticket",
          "kb ls -l bug            has label bug          (-l '!bug': does not have it)",
          "kb ls -p priority:high  property equals value  (-p priority: property is set)",
          "kb ls -p '!status:done' property is not that value",
        ],
      ],
      [
        "Output",
        [
          "JSON by default (for scripts); --format text shows the board for humans.",
          "--limit/--full are JSON-only: at most 50 tickets unless you pass --limit (0 = all).",
          "Do not combine --limit/--full with --format text. -b picks one board.",
        ],
      ],
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
    sections: [
      [
        "Notes",
        [
          "- Prints the ticket's properties, body and comments.",
          "- Ids are looked up on the default board first: 'kb show 31' finds ticket 31 of the default board.",
          "- Use -b <board> for another board, or -a/--all to search every board.",
        ],
      ],
    ],
    examples: ["kb show 1", "kb show 31 -b other", "kb show 31 --all", "kb show ABC-1"],
  },
  add: {
    sections: [
      [
        "Notes",
        [
          "- The new ticket goes in the first column unless you pass -s.",
          "- --body - reads the body from stdin; -e opens the new ticket in $EDITOR.",
          "- Prints '#<id> <path>'.",
          AUTO,
        ],
      ],
    ],
    examples: [
      'kb add "Fix login bug" -l bug -p priority:high',
      'kb add -n "Write docs" -s doing -b another-board --body "see wiki"',
      'echo "long body" | kb add "From stdin" --body -',
      'kb add "Custom" -f custom.md --id ABC-1 -c "created by hand"',
      'kb add "Needs details" -e',
    ],
  },
  set: {
    sections: [
      [
        "Notes",
        [
          "- Only the given fields change; give at least one.",
          "- -l adds labels, --unlabel removes them; -p sets properties, --unset removes them.",
          AUTO,
        ],
      ],
    ],
    examples: [
      "kb set 1 -p priority:low -l urgent",
      "kb set 1 --unset priority --unlabel bug",
      'kb set 1 -n "Fix login redirect bug"',
      'kb set 1 -s done -c "shipped"',
    ],
  },
  mv: {
    sections: [["Notes", ["- Same as 'kb set <id> -s <status>'. An unknown column warns and uses 'unsorted'.", AUTO]]],
    examples: ["kb mv 1 doing", "kb mv 007 done", "kb mv 1 done --no-automation"],
  },
  edit: {
    sections: [["Notes", 'Opens the ticket file in $EDITOR (default vi), e.g. EDITOR="code -w".']],
    examples: ["kb edit 1", "EDITOR=nano kb edit 1", 'EDITOR="code -w" kb edit 1'],
  },
  comment: {
    sections: [["Notes", "Appends a timestamped comment to the ticket."]],
    examples: ['kb comment 1 "blocked on X"', 'kb comment 1 "unblocked, retrying"'],
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
    sections: [
      [
        "Notes",
        [
          "- Read-only unless the action is 'kill': shows what is running now (default) or every rule.",
          "- JSON by default (for scripts); --format text prints a table. -b picks one board.",
          "- 'kill' works from any process: the pid is stored in the ticket's automations frontmatter.",
          "- Setup of automations is documented in the README (Automations).",
        ],
      ],
      [
        "Actions",
        [
          "",
          "ls                 running automations now (default)",
          "ls --all           every configured rule with its last run and counts",
          "kill -t 7 -r lint  stop one run (ticket 7, rule lint)",
          "kill -t 7          stop every run on ticket 7 (asks for --all if several)",
          "kill --all         stop everything running on this board",
          "kill ... --dry-run show the targets, signal nothing",
        ],
      ],
    ],
    examples: [
      "kb automations",
      "kb automations ls --all --format text",
      "kb automations kill -t 7 -r lint",
      "kb automations kill --all --dry-run",
    ],
  },
  web: {
    sections: [
      [
        "Notes",
        [
          "- Run in the folder with kanban.yaml. Prints 'kb web running at <url>' and opens it.",
          "- Default port is 4747 (next free one if busy). Press Ctrl-C to stop.",
          "- There is no login: only bind --host to networks you trust.",
          AUTO,
        ],
      ],
    ],
    examples: ["kb web", "kb web --port 8080 --no-open", "kb web --no-automation"],
  },
  mcp: {
    sections: [
      [
        "Notes",
        [
          "- Stdio only: no port is opened and nothing listens on the network.",
          "- An MCP client (editor, agent) spawns 'kb mcp' itself; you do not run it by hand.",
          "- stdout is the protocol channel: stdout carries JSON-RPC, everything else goes to stderr.",
          "- No auth or loopback concerns: access is whatever the spawning client already has.",
          "- Automations are fire-and-forget: a write tool returns before its automation finishes.",
          "- --dir picks the board directory (default: current directory).",
          AUTO,
        ],
      ],
    ],
    examples: ["kb mcp", "kb mcp --dir ../other-board", "kb mcp --no-automation"],
  },
  completion: {
    sections: [
      [
        "Install",
        [
          "zsh (needs: autoload -U compinit && compinit):",
          "  source <(kb completion zsh)",
          "  persist: echo 'source <(kb completion zsh)' >> ~/.zshrc",
          "",
          "bash:",
          "  source <(kb completion bash)",
          "  persist: echo 'source <(kb completion bash)' >> ~/.bashrc",
          "  or: kb completion bash > /etc/bash_completion.d/kb",
        ],
      ],
    ],
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
