import type { Command } from "commander";
import { bash } from "./completion-bash.js";
import { inspect } from "./completion-model.js";
import { zsh } from "./completion-zsh.js";

export const SHELLS = ["bash", "zsh"] as const;

/** Generate a completion script for `shell` from the commander program. */
export function generate(program: Command, shell: string): string {
  const { global, cmds } = inspect(program);
  if (shell === "bash") return bash(global, cmds);
  if (shell === "zsh") return zsh(global, cmds);
  throw new Error(`unknown shell "${shell}" (expected one of: ${SHELLS.join(", ")})`);
}
