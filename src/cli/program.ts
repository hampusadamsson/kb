import { Command } from "commander";
import { boards } from "./commands/boards.js";
import { useColor } from "./format.js";
import { fix } from "./commands/fix.js";
import { init } from "./commands/init.js";
import { ls, lsJson, parseLimit } from "./commands/ls.js";
import { show } from "./commands/show.js";
import { defaultOpener, runWeb } from "./commands/web.js";
import { validate } from "./commands/validate.js";
import { add, comment, edit, mv, set, type AddOpts, type SetOpts } from "./commands/write.js";

export const commandNames = [
  "init", "ls", "boards", "show", "add", "set", "mv",
  "edit", "comment", "fix", "validate", "web",
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

  program.command("ls").description("List tickets (JSON by default; --format text for a board view)")
    .argument("[text]", "case-insensitive substring match on the whole file; leading ! negates")
    .option("-b, --board <board>", "only this board")
    .option("-l, --label <label>", "has label (repeatable)", collect)
    .option("-p, --property <key[:value]>", "property equals value, or exists (repeatable)", collect)
    .option("--format <format>", "json (default) or text", "json")
    .option("--full", "json: include body and comments")
    .option("--limit <n>", "json: max tickets, 0 = no limit (default 50; warns when cut)")
    .addHelpText("after", `
Filters are ANDed. Prefix a value with ! to negate it (quote with single
quotes in the shell): -l '!bug'  -p '!priority:low'  -p '!priority'  '!wip'
Examples:
  kb ls -l bug -p priority:high
  kb ls -p '!status:done'
  kb ls login
  kb ls --full -l bug          include bodies and comments
  kb ls --limit 0              all tickets
  kb ls --format text          board view for humans`)
    .action((text: string | undefined, o: { board?: string; label?: string[]; property?: string[]; format: string; full?: boolean; limit?: string }) => run(() => {
      if (o.format !== "json" && o.format !== "text") throw new Error(`--format must be json or text, got "${o.format}"`);
      const f = { board: o.board, text, labels: o.label, props: o.property };
      const r = o.format === "text" ? ls(cwd(), { ...f, color: useColor() }) : lsJson(cwd(), { ...f, full: o.full, limit: parseLimit(o.limit) });
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

  program.command("web").description("Start the local web UI")
    .option("--host <addr>", "address to bind", "127.0.0.1")
    .option("--port <n>", "port (default 4747, auto-increments if busy)")
    .option("--no-open", "do not open the browser")
    .action(async (o: { host: string; port?: string; open: boolean }) => {
      try {
        const server = await runWeb(cwd(), o, {
          out: (s) => console.log(s),
          err: (s) => console.error(s),
          opener: defaultOpener,
        });
        const stop = (): void => {
          server.close().then(() => process.exit(0), () => process.exit(1));
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      } catch (e) {
        console.error(`error: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });
  return program;
}
