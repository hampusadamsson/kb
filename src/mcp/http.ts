// MCP over HTTP: the same tools, the same pure dispatcher, a request/response shape instead of stdio.
//
// Deliberately stateless: no sessions, no `Mcp-Session-Id`, no server-initiated stream. One POST is
// one JSON-RPC message (or a batch array) in and one JSON body out, so any client, proxy or retry can
// replay it. The stdio transport in protocol.ts is untouched; both transports share `createTools`.
import type { EventLog } from "../eventLog.js";
import { createKanban, type Kanban } from "../core/index.js";
import type { LiveRuns } from "../liveRuns.js";
import type { AutomationRunner } from "../core/automation.js";
import { createDispatcher } from "./protocol.js";
import { createTools, INSTRUCTIONS, type ToolContext } from "./server.js";

export interface McpHttpContext extends ToolContext {
  /** Usage guidance advertised by `initialize`; the same text the stdio server sends. */
  instructions: string;
}

export interface McpHttpResponse {
  status: number;
  /** `undefined` for a notification: 202 carries no body at all. */
  body: unknown;
}

/** What the web server already has: the board directory and the shared runtime services. */
export interface McpHttpOptions {
  /** board directory (contains kanban.yaml) */
  dir: string;
  /** runs automations; absent → none run */
  runner?: AutomationRunner;
  /** audit event log */
  events?: EventLog;
  /** registry the runner reports running automations to */
  live?: LiveRuns;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Wires a context the way `startMcpServer` wires the stdio server: a fresh Kanban per tool call,
 * `source: "mcp"` on every event, and the same instructions. Cheap, so build it per request.
 */
export function createMcpHttpContext(opts: McpHttpOptions): McpHttpContext {
  const { dir, runner, events, live } = opts;
  return {
    kanban: (): Kanban => createKanban({ dir, runner, events, source: "mcp" }),
    api: { runner, events, live, dir },
    instructions: INSTRUCTIONS,
  };
}

/**
 * Answers one HTTP POST body. JSON-RPC level failures (unknown method, bad params, unknown tool)
 * come back as error objects from the dispatcher, so they travel with status 200 — only a body that
 * is neither an object nor an array is an HTTP-level mistake.
 */
export async function handleMcpHttp(body: unknown, ctx: McpHttpContext): Promise<McpHttpResponse> {
  const batch = Array.isArray(body);
  if (!batch && !isRecord(body)) {
    return { status: 400, body: { error: "body must be a JSON-RPC object or a batch array", code: "bad-json" } };
  }
  // Tools close over `ctx.kanban`, so the dispatcher is built per request: each tool call gets a
  // fresh board view, exactly like startMcpServer does for stdio.
  const dispatcher = createDispatcher({ tools: createTools(ctx), instructions: ctx.instructions });
  const messages: unknown[] = batch ? (body as unknown[]) : [body];
  const responses: unknown[] = [];
  for (const message of messages) {
    const response = await dispatcher.handleMessage(message);
    // undefined means "notification": it gets no reply, not even inside a batch.
    if (response !== undefined) responses.push(response);
  }
  // Nothing but notifications (or an empty batch): accepted, nothing to say back.
  if (responses.length === 0) return { status: 202, body: undefined };
  return { status: 200, body: batch ? responses : responses[0] };
}
