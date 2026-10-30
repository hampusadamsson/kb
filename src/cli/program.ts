import { Command } from "commander";
import { boards } from "./commands/boards.js";
import { useColor } from "./format.js";
import { fix } from "./commands/fix.js";
import { init } from "./commands/init.js";
import { ls } from "./commands/ls.js";
import { show } from "./commands/show.js";
import { validate } from "./commands/validate.js";
import { add, comment, edit, mv, set, type AddOpts, type SetOpts } from "./commands/write.js";

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

  const collect = (v: string, prev: string[] = []) => [...prev, v];

  program.command("ls").description("List tickets by board and column")
    .argument("[text]", "case-insensitive substring match on the whole file; leading ! negates")
    .option("-b, --board <board>", "only this board")
    .option("-l, --label <label>", "has label (repeatable)", collect)
    .option("-p, --property <key[:value]>", "property equals value, or exists (repeatable)", collect)
    .addHelpText("after", `
Filters are ANDed. Prefix a value with ! to negate it (quote with single
quotes in the shell): -l '!bug'  -p '!priority:low'  -p '!priority'  '!wip'
Examples:
  kb ls -l bug -p priority:high
  kb ls -p '!status:done'
  kb ls login`)
    .action((text: string | undefined, o: { board?: string; label?: string[]; property?: string[] }) => run(() => {
      const r = ls(cwd(), { board: o.board, color: useColor(), text, labels: o.label, props: o.property });
      for (const w of r.warnings) console.error(w);
      if (r.out) console.log(r.out);
    }));

  program.command("boards").description("List boards")
    .action(() => run(() => console.log(boards(cwd()))));

  program.command("show").description("Print a ticket").argument("<id>")
    .action((id: string) => run(() => console.log(show(cwd(), id))));

  const common = (c: Command): Command =>
    c
      .option("-n, --name <name>", "ticket name")
      .option("-s, --status <status>", "status (column)")
      .option("-b, --board <board>", "board")
      .option("-l, --label <label>", "label (repeatable)", collect)
      .option("-p, --property <key:value>", "property (repeatable)", collect)
      .option("--body <text>", "body text (- = stdin)")
      .option("-c, --comment <text>", "add comment")
      .option("-e, --edit", "open $EDITOR afterwards");

  common(program.command("add").description("Create a ticket").argument("[name]"))
    .option("-f, --file <path>", "file path")
    .option("--id <value>", "explicit id")
    .action((name: string | undefined, o: AddOpts) => run(() => console.log(add(cwd(), name, o))));

  common(program.command("set").description("Change ticket fields").argument("<id>"))
    .option("--unset <key>", "remove property (repeatable)", collect)
    .option("--unlabel <label>", "remove label (repeatable)", collect)
    .action((id: string, o: SetOpts) => run(() => console.log(set(cwd(), id, o))));

  program.command("mv").description("Change ticket status").argument("<id>").argument("<status>")
    .action((id: string, status: string) => run(() => console.log(mv(cwd(), id, status))));

  program.command("edit").description("Open ticket in $EDITOR").argument("<id>")
    .action((id: string) => run(() => edit(cwd(), id)));

  program.command("comment").description("Add a comment").argument("<id>").argument("<text>")
    .action((id: string, text: string) => run(() => console.log(comment(cwd(), id, text))));

  program.command("fix").description("Repair missing/duplicate ids")
    .option("--dry-run", "show changes without writing")
    .action((o: { dryRun?: boolean }) => run(() => console.log(fix(cwd(), !!o.dryRun))));

  program.command("validate").description("Check config and tickets")
    .action(() => run(() => {
      const r = validate(cwd());
      console.log(r.out);
      if (r.errors > 0) process.exitCode = 1;
    }));
  return program;
}
