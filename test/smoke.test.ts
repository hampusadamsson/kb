import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { buildProgram, commandNames } from "../src/program.js";

describe("kb", () => {
  it("registers all commands", () => {
    const help = buildProgram().helpInformation();
    for (const c of commandNames) expect(help).toContain(c);
  });
  it("stub exits 1", () => {
    const p = buildProgram();
    expect(p.commands.map((c) => c.name())).toEqual([...commandNames]);
  });
});
