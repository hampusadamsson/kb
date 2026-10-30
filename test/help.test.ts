import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { buildProgram, commandNames } from "../src/cli/program.js";
import { addExamples, addSection, configureHelp, formatHelp } from "../src/cli/help.js";
import { makeStyle } from "../src/cli/format.js";

const plain = (c: Command): string => formatHelp(c, c.createHelp(), makeStyle(false));
const sub = (n: string): Command => buildProgram().commands.find((c) => c.name() === n)!;
const idx = (s: string, h: string): number => s.indexOf(`\n${h}\n`);

describe("root help", () => {
  const out = plain(buildProgram());
  it("has sections in order", () => {
    const pos = ["USAGE", "MAIN COMMANDS", "OTHER COMMANDS", "FLAGS", "LEARN MORE"].map((h) => idx("\n" + out, h));
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
    expect(out).toContain("kb <command> [flags]");
  });
  it("lists each public command once, no __complete", () => {
    for (const c of commandNames) expect(out.match(new RegExp(`^  ${c} `, "gm"))?.length).toBe(1);
    expect(out).not.toContain("__complete");
    expect(out).toMatch(/^  help /m);
  });
  it("lines <= 100 and no ANSI", () => {
    for (const l of out.split("\n")) expect(l.length).toBeLessThanOrEqual(100);
    expect(out).not.toContain("\x1b");
  });
});

describe("subcommand help", () => {
  const out = plain(sub("mv"));
  it("sections", () => {
    expect(out).toContain("  kb mv <id> <status> [flags]");
    expect(out).toContain("\nARGUMENTS\n");
    expect(out).toMatch(/\nFLAGS\n(.*\n)*  -h, --help/);
    expect(out).toMatch(/\nINHERITED FLAGS\n  --no-automation/);
    expect(out).toContain("Use 'kb help' to list all commands.");
  });
  it("aligns flags", () => {
    const ls = plain(sub("ls"));
    const lines = ls.split("\n").filter((l) => /^ {2}(-\w, |    )--/.test(l));
    expect(lines.length).toBeGreaterThan(3);
    const col = (l: string): number => l.match(/^(\s*(?:-\w, )?\s*--[\w-]+(?: <[^>]+>)?\s{2,})\S/)![1]!.length;
    expect(new Set(lines.map(col)).size).toBe(1);
  });
});

describe("style and helpers", () => {
  it("bold when styled", () => {
    const c = buildProgram();
    expect(formatHelp(c, c.createHelp(), makeStyle(true))).toContain("\x1b[1mUSAGE\x1b[22m");
  });
  it("addExamples / addSection", () => {
    const p = new Command("kb");
    const c = p.command("x").description("Do x");
    addExamples(c, ["kb x 1"]);
    addSection(c, "Notes", "Some text.");
    configureHelp(p);
    const out = plain(c);
    expect(out).toContain("EXAMPLES\n  $ kb x 1");
    expect(out).toContain("NOTES\n  Some text.");
    expect(out.indexOf("NOTES")).toBeLessThan(out.indexOf("EXAMPLES"));
    expect(out.indexOf("EXAMPLES")).toBeLessThan(out.indexOf("LEARN MORE"));
  });
  it("buildProgram output has no ANSI (non-TTY)", () => {
    expect(buildProgram().helpInformation()).not.toContain("\x1b");
  });
});
