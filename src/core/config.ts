import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { KanbanError } from "./errors.js";

export const CONFIG_FILE = "kanban.yaml";

const columnsSchema = z.array(z.string()).min(1, "columns must not be empty");

export const automationSchema = z.object({
  name: z.string(),
  when: z
    .object({
      moved_to: z.string().optional(),
      created_in: z.string().optional(),
      labels: z.array(z.string()).optional(),
      props: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    })
    .refine((w) => (w.moved_to !== undefined) !== (w.created_in !== undefined), {
      message: "when needs exactly one of moved_to / created_in",
    }),
  run: z.string(),
  enabled: z.boolean().optional(),
  /** loop guard (default true): stop after AUTOMATION_RUN_LIMIT runs per ticket; false opts out */
  guard: z.boolean().optional(),
});

const automationsSchema = z.array(automationSchema).optional();

export type Automation = z.infer<typeof automationSchema>;

const configSchema = z.object({
  name: z.string().default("default"),
  columns: columnsSchema,
  glob: z.string().default("*.md"),
  automations: automationsSchema,
  boards: z
    .record(z.string(), z.object({ columns: columnsSchema, automations: automationsSchema }))
    .optional(),
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

/** Automations of a board; not inherited from the default board. */
export function automationsFor(config: Config, board: string): Automation[] {
  if (board === config.name) return config.automations ?? [];
  return config.boards?.[board]?.automations ?? [];
}

export function columnsFor(config: Config, board: string): string[] {
  return config.boards?.[board]?.columns ?? config.columns;
}
