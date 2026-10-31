import type { Command } from "commander";

export interface Opt {
  long: string;
  short?: string;
  takesValue: boolean;
  desc: string;
}
export interface Cmd {
  name: string;
  desc: string;
  opts: Opt[];
}

/** What a value-taking option completes to ("none" = nothing). */
export const VALUE_KINDS: Record<string, string> = {
  "--status": "columns",
  "--board": "boards",
  "--label": "labels",
  "--unlabel": "labels",
  "--property": "propkeys",
  "--unset": "propkeys",
  "--ticket": "ids",
  "--rule": "rules",
  "--format": "words:json text",
};
export const ID_COMMANDS = ["show", "set", "mv", "edit", "comment"];

/** Sub-actions per command, for positional completion of `kb <cmd> <action>`. */
export const ACTIONS: Record<string, string[]> = { automations: ["ls", "kill"] };

const toOpt = (o: Command["options"][number]): Opt => ({
  long: o.long ?? "",
  short: o.short,
  takesValue: Boolean(o.required || o.optional),
  desc: o.description,
});

/** Introspect the commander program (visible commands, long+short options). */
export function inspect(program: Command): { global: Opt[]; cmds: Cmd[] } {
  const help: Opt = { long: "--help", short: "-h", takesValue: false, desc: "display help" };
  const global = [...program.options.filter((o) => !o.hidden && o.long).map(toOpt), help];
  const cmds = program
    .createHelp()
    .visibleCommands(program)
    .map((c) => ({
      name: c.name(),
      desc: c.description(),
      opts: c.options.filter((o) => !o.hidden && o.long).map(toOpt),
    }));
  return { global, cmds };
}

export const flags = (o: Opt): string[] => (o.short ? [o.short, o.long] : [o.long]);

export function allOpts(g: Opt[], c: Cmd): Opt[] {
  const seen = new Set<string>();
  return [...c.opts, ...g].filter((o) => !seen.has(o.long) && !!seen.add(o.long));
}

export const kindsOf = (g: Opt[], cmds: Cmd[]): Map<string, Opt[]> => {
  const m = new Map<string, Opt[]>();
  for (const o of [...g, ...cmds.flatMap((c) => c.opts)]) {
    if (!o.takesValue) continue;
    const k = VALUE_KINDS[o.long] ?? "none";
    const list = m.get(k) ?? [];
    if (!list.some((x) => x.long === o.long)) list.push(o);
    m.set(k, list);
  }
  return m;
};
