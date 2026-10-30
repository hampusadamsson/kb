import { Command } from "commander";
import { boards } from "./commands/boards.js";
import { useColor } from "./commands/format.js";
import { init } from "./commands/init.js";
import { ls } from "./commands/ls.js";
import { show } from "./commands/show.js";

export const commandNames = [
  "init", "ls", "boards", "show", "add", "set", "mv",
  "edit", "comment", "fix", "validate",
] as const;

/** Central error handler: message to stderr, exit code 1. */
function run(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

export function buildProgram(cwd: () => string = () => process.cwd()): Command {
  const program = new Command("kb").description("Local markdown kanban CLI");

  program.command("init").description("Write starter kanban.yaml")
    .action(() => run(() => console.log(init(cwd()))));

  program.command("ls").description("List tickets by board and column")
    .option("-b, --board <board>", "only this board")
    .action((o: { board?: string }) => run(() => {
      const r = ls(cwd(), { board: o.board, color: useColor() });
      for (const w of r.warnings) console.error(w);
      if (r.out) console.log(r.out);
    }));

  program.command("boards").description("List boards")
    .action(() => run(() => console.log(boards(cwd()))));

  program.command("show").description("Print a ticket").argument("<id>")
    .action((id: string) => run(() => console.log(show(cwd(), id))));

  const stubs = commandNames.filter((n) => !["init", "ls", "boards", "show"].includes(n));
  for (const name of stubs) {
    program
      .command(name)
      .allowUnknownOption()
      .allowExcessArguments()
      .helpOption(false)
      .action(() => {
        console.error("not implemented");
        process.exit(1);
      });
  }
  return program;
}
