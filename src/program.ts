import { Command } from "commander";

export const commandNames = [
  "init", "ls", "boards", "add", "set", "mv",
  "show", "edit", "comment", "fix", "validate",
] as const;

export function buildProgram(): Command {
  const program = new Command("kb").description("Local markdown kanban CLI");
  for (const name of commandNames) {
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
