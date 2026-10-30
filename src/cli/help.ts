import type { Command, Help } from "commander";
import { makeStyle, useColor, type Style } from "./format.js";

export const WIDTH = 100;
export const MAIN_COMMANDS = ["ls", "add", "mv", "set", "show", "comment", "edit"] as const;
const ROOT_INTRO = "Local markdown kanban CLI.";

export interface HelpSection {
  title: string;
  body?: string;
  lines?: string[];
}

/** Extension properties stored on commander commands. */
export type HelpCommand = Command & { helpSections?: HelpSection[]; examples?: string[] };

export function addExamples(cmd: Command, examples: string[]): Command {
  const c = cmd as HelpCommand;
  c.examples = [...(c.examples ?? []), ...examples];
  return cmd;
}

export function addSection(cmd: Command, title: string, text: string | string[]): Command {
  const c = cmd as HelpCommand;
  const s: HelpSection = Array.isArray(text) ? { title, lines: text } : { title, body: text };
  c.helpSections = [...(c.helpSections ?? []), s];
  return cmd;
}

/** Word-wrap text to width with a first-line prefix and a hanging indent. */
export function wrap(text: string, width: number, first: string, hang: string): string[] {
  const out: string[] = [];
  let line = first;
  let empty = true;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!empty && line.length + 1 + word.length > width) {
      out.push(line);
      line = hang + word;
    } else {
      line += (empty ? "" : " ") + word;
    }
    empty = false;
  }
  out.push(line);
  return out;
}

function wrapParagraphs(text: string, width: number, indent: string): string[] {
  const out: string[] = [];
  for (const p of text.trim().split(/\n\s*\n/)) {
    if (out.length) out.push("");
    out.push(...wrap(p, width, indent, indent));
  }
  return out;
}

/** Two-column list; column width = longest term + 2. */
function table(rows: [string, string][], style?: Style): string[] {
  const w = Math.max(...rows.map(([t]) => t.length)) + 2;
  return rows.flatMap(([term, desc]) => {
    const pad = " ".repeat(w - term.length);
    const shown = style ? style.bold(term) : term;
    if (!desc) return [`  ${shown}`];
    const lines = wrap(desc, WIDTH, "  " + term + pad, " ".repeat(w + 2));
    lines[0] = `  ${shown}${pad}${lines[0]!.slice(w + 2)}`;
    return lines;
  });
}

function fullName(cmd: Command): string {
  const names: string[] = [];
  for (let c: Command | null = cmd; c; c = c.parent) names.unshift(c.name());
  return names.join(" ");
}

function usage(cmd: Command, help: Help): string {
  const base = fullName(cmd);
  if (!cmd.parent) return `${base} <command> [flags]`;
  if (help.visibleCommands(cmd).length > 0) return `${base} <command> [flags]`;
  const args = cmd.registeredArguments.map((a) => {
    const n = a.name() + (a.variadic ? "..." : "");
    return a.required ? `<${n}>` : `[${n}]`;
  });
  return [base, ...args, "[flags]"].join(" ");
}

function flagRows(opts: readonly import("commander").Option[]): [string, string][] {
  const anyShort = opts.some((o) => o.short);
  return opts.map((o) => {
    const long = o.flags.replace(/^-\w,?\s*/, "");
    const term = o.short ? o.flags : anyShort ? `    ${long}` : long;
    return [term, o.description ?? ""];
  });
}

function mkFormat(style: () => Style) {
  return (cmd: Command, help: Help): string => {
    const st = style();
    const blocks: string[][] = [];
    const section = (title: string, lines: string[]): void => {
      if (lines.length) blocks.push([st.bold(title), ...lines]);
    };
    const desc = cmd.parent ? cmd.description() : ROOT_INTRO;
    if (desc) blocks.push(wrapParagraphs(desc, WIDTH, ""));
    section("USAGE", [`  ${usage(cmd, help)}`]);

    const cmds = help.visibleCommands(cmd);
    const row = (c: Command): [string, string] => [c.name(), help.subcommandDescription(c)];
    if (!cmd.parent) {
      const main = MAIN_COMMANDS.flatMap((n) => cmds.filter((c) => c.name() === n));
      const rest = cmds.filter((c) => !main.includes(c));
      if (main.length) section("MAIN COMMANDS", table(main.map(row)));
      if (rest.length) section("OTHER COMMANDS", table(rest.map(row)));
    } else if (cmds.length) {
      section("COMMANDS", table(cmds.map(row)));
    }

    if (cmd.registeredArguments.length) {
      section("ARGUMENTS", table(cmd.registeredArguments.map((a) => [a.required ? `<${a.name()}>` : `[${a.name()}]`, a.description] as [string, string])));
    }

    const opts = help.visibleOptions(cmd);
    const inherited: import("commander").Option[] = [];
    for (let a = cmd.parent; a; a = a.parent) {
      inherited.push(...help.visibleOptions(a).filter((o) => o.long !== "--help" && o.long !== "--version"));
    }
    const inh = new Set(inherited.map((o) => o.long));
    const help_ = opts.filter((o) => o.long === "--help");
    const own = [...opts.filter((o) => o.long !== "--help" && !(cmd.parent && inh.has(o.long))), ...help_];
    if (own.length) section("FLAGS", table(flagRows(own)));
    if (inherited.length) section("INHERITED FLAGS", table(flagRows(inherited)));

    for (const s of (cmd as HelpCommand).helpSections ?? []) {
      section(s.title.toUpperCase(), s.lines ? s.lines.map((l) => (l ? `  ${l}` : l)) : wrapParagraphs(s.body ?? "", WIDTH, "  "));
    }
    const ex = (cmd as HelpCommand).examples;
    if (ex?.length) section("EXAMPLES", ex.map((e) => `  $ ${e}`));
    section("LEARN MORE", [
      cmd.parent ? "  Use 'kb help' to list all commands." : "  Use 'kb <command> --help' for more information about a command.",
    ]);
    return blocks.map((b) => b.join("\n")).join("\n\n") + "\n";
  };
}

/** Pure formatter with an injectable style (for tests). */
export function formatHelp(cmd: Command, help: Help, style: Style = makeStyle(useColor())): string {
  return mkFormat(() => style)(cmd, help);
}

/** Apply the formatter to a command and all its (current) subcommands. */
export function configureHelp(program: Command): void {
  program.configureHelp({ formatHelp: (cmd, help) => formatHelp(cmd, help, makeStyle(useColor())) });
  for (const c of program.commands) configureHelp(c);
}
