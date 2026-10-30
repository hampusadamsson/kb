import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { KanbanError } from "./errors.js";

export const CONFIG_FILE = "kanban.yaml";

const columnsSchema = z.array(z.string()).min(1, "columns must not be empty");

const configSchema = z.object({
  name: z.string().default("default"),
  columns: columnsSchema,
  glob: z.string().default("*.md"),
  boards: z.record(z.string(), z.object({ columns: columnsSchema })).optional(),
});

export type Config = z.infer<typeof configSchema>;

export const STARTER_CONFIG = `name: default
columns: [todo, doing, done]
glob: "*.md"
`;

export function loadConfig(cwd: string): Config {
  const file = path.join(cwd, CONFIG_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new KanbanError("config", `${CONFIG_FILE} not found in ${cwd} (run \`kb init\`)`);
  }
  let data: unknown;
  try {
    data = parse(text);
  } catch (e) {
    throw new KanbanError("config", `${CONFIG_FILE}: invalid YAML: ${(e as Error).message}`);
  }
  const result = configSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new KanbanError("config", `${CONFIG_FILE}: invalid config: ${issues}`);
  }
  return result.data;
}

export function columnsFor(config: Config, board: string): string[] {
  return config.boards?.[board]?.columns ?? config.columns;
}
