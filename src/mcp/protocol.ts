// Hand-rolled MCP server over newline-delimited JSON-RPC 2.0 on stdio.
//
// Deliberately dependency-free: @modelcontextprotocol/sdk costs 4.5MB / 701 files / 20 deps for a
// protocol that is a switch statement plus a line splitter. This file owns the wire format only —
// tool-level failures (bad input, missing ticket, ...) are the tool layer's job and must come back
// as `isError: true` tool results; this file just relays whatever a tool handler returns.
import { StringDecoder } from "node:string_decoder";
import { VERSION } from "../version.js";

/** Protocol revisions we can speak. Never advertise a revision that is not in this list. */
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export type ProtocolVersion = (typeof PROTOCOL_VERSIONS)[number];

/** Answered when the client asks for a revision we do not know. */
export const DEFAULT_PROTOCOL_VERSION: ProtocolVersion = "2025-06-18";

export const ErrorCode = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** One entry of a `tools/call` result content array. The tool layer may add other shapes. */
export interface ToolContent {
  type: string;
  text?: string;
}

/** `tools/call` result. `isError: true` is how the tool layer reports failures (never a throw). */
export interface ToolCallResult {
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolAnnotations {
  /** the tool does not modify anything */
  readOnlyHint?: boolean;
  /** the tool may perform destructive updates */
  destructiveHint?: boolean;
  /** calling it repeatedly with the same arguments has the same effect as calling it once */
  idempotentHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema for the arguments; defaults to an open object schema. */
  inputSchema?: Record<string, unknown>;
  /** behaviour hints, relayed verbatim in `tools/list` */
  annotations?: ToolAnnotations;
  handler: (args: Record<string, unknown>) => ToolCallResult | Promise<ToolCallResult>;
}

export interface DispatcherHandlers {
  /** Advertised in `initialize`; defaults to `{ name: "kb", version: VERSION }`. */
  serverInfo?: { name: string; version?: string };
  /** Usage guidance for the model; advertised in `initialize` when set. */
  instructions?: string;
  tools?: readonly ToolDefinition[];
}

export interface Dispatcher {
  /** Returns the JSON-RPC response to write, or undefined when the message gets no response. */
  handleMessage(msg: unknown): Promise<unknown | undefined>;
}

export interface RunServerOptions extends DispatcherHandlers {
  /** defaults to process.stdin; injectable for tests */
  stdin?: AsyncIterable<Uint8Array | string>;
  /** defaults to process.stdout; receives one compact JSON line per response and nothing else */
  stdout?: { write(chunk: string): unknown };
}

const OPEN_SCHEMA: Record<string, unknown> = { type: "object", properties: {} };

/** A JSON-RPC level failure (bad params, ...) rather than a tool failure. */
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const ok = (id: JsonRpcId, result: unknown): JsonRpcSuccess => ({ jsonrpc: "2.0", id, result });
const fail = (id: JsonRpcId, code: number, message: string): JsonRpcFailure => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

function toId(v: unknown): JsonRpcId {
  return typeof v === "string" || typeof v === "number" ? v : null;
}

/** Echoes the client's revision when we speak it, otherwise answers with our default. */
function negotiate(raw: unknown): ProtocolVersion {
  return PROTOCOL_VERSIONS.includes(raw as ProtocolVersion) ? (raw as ProtocolVersion) : DEFAULT_PROTOCOL_VERSION;
}

/**
 * Pure dispatcher: no I/O, no globals, no process state. Callers feed it one decoded message
 * (an already-parsed value, or a raw JSON string) and write out whatever it returns.
 */
export function createDispatcher(handlers: DispatcherHandlers = {}): Dispatcher {
  const tools = handlers.tools ?? [];
  const serverInfo = {
    name: handlers.serverInfo?.name ?? "kb",
    version: handlers.serverInfo?.version ?? VERSION,
  };

  const listTools = (): { tools: Record<string, unknown>[] } => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? OPEN_SCHEMA,
      ...(t.annotations ? { annotations: t.annotations } : {}),
    })),
  });

  const callTool = async (params: Record<string, unknown> | undefined): Promise<ToolCallResult> => {
    const name = params?.name;
    if (typeof name !== "string") throw new RpcError(ErrorCode.invalidParams, "tools/call requires a string `name`");
    const args = isRecord(params?.arguments) ? params.arguments : {};
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new RpcError(ErrorCode.invalidParams, `unknown tool: ${name}`);
    // No try/catch here on purpose: domain failures belong in the returned result (`isError`), so a
    // throw means a genuine bug and is reported as an internal fault by the caller.
    return await tool.handler(args);
  };

  const dispatch = async (method: string, params: Record<string, unknown> | undefined): Promise<unknown> => {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: negotiate(params?.protocolVersion),
          capabilities: { tools: {} },
          serverInfo,
          ...(handlers.instructions ? { instructions: handlers.instructions } : {}),
        };
      case "ping":
        return {};
      case "tools/list":
        return listTools();
      case "tools/call":
        return await callTool(params);
      // Notifications are normally answered by returning undefined in handleMessage below; these
      // cases only matter for a client that (wrongly) attaches an id, where silence would hang it.
      case "notifications/initialized":
      case "notifications/cancelled":
        return {};
      default:
        throw new RpcError(ErrorCode.methodNotFound, `method not found: ${method}`);
    }
  };

  return {
    async handleMessage(msg: unknown): Promise<unknown | undefined> {
      let message = msg;
      if (typeof message === "string") {
        try {
          message = JSON.parse(message);
        } catch {
          return fail(null, ErrorCode.parseError, "parse error");
        }
      }
      if (!isRecord(message)) return fail(null, ErrorCode.invalidRequest, "invalid request: expected a JSON object");

      const id = "id" in message ? toId(message.id) : null;
      const isNotification = !("id" in message);
      if (message.jsonrpc !== "2.0") return fail(id, ErrorCode.invalidRequest, 'invalid request: jsonrpc must be "2.0"');
      const method = message.method;
      if (typeof method !== "string") return fail(id, ErrorCode.invalidRequest, "invalid request: method must be a string");
      // Notifications never get a response, not even for unknown methods.
      if (isNotification) return undefined;

      const params = isRecord(message.params) ? message.params : undefined;
      try {
        const result = await dispatch(method, params);
        return result === undefined ? undefined : ok(id, result);
      } catch (e) {
        if (e instanceof RpcError) return fail(id, e.code, e.message);
        return fail(id, ErrorCode.internalError, `internal error: ${(e as Error)?.message ?? String(e)}`);
      }
    },
  };
}

/**
 * Keeps stdout clean: MCP framing is the only thing allowed on it, so anything a stray
 * `console.log`/`process.stdout.write` would print goes to stderr instead. Called from
 * `runServer()` (not at import time, so importing this module in tests is side-effect free).
 */
export function redirectStdoutToStderr(): void {
  const toStderr = (chunk: unknown, encoding?: unknown, cb?: unknown): boolean =>
    (process.stderr.write as (...a: unknown[]) => boolean)(chunk, encoding, cb);
  process.stdout.write = toStderr as unknown as typeof process.stdout.write;
  console.log = (...args: unknown[]): void => {
    (console.error as (...a: unknown[]) => void)(...args);
  };
  console.info = (...args: unknown[]): void => {
    (console.error as (...a: unknown[]) => void)(...args);
  };
}

/**
 * stdio transport: read newline-delimited JSON-RPC from `stdin`, write one compact JSON line per
 * response to `stdout`, and nothing else.
 */
export async function runServer(opts: RunServerOptions = {}): Promise<void> {
  const stdin = opts.stdin ?? process.stdin;
  const out = opts.stdout ?? process.stdout;
  // Capture the real write function BEFORE redirecting stdout to stderr, which replaces
  // process.stdout.write on the very object captured below.
  const writeRaw = out.write.bind(out);
  const dispatcher = createDispatcher(opts);

  redirectStdoutToStderr();

  const write = (msg: unknown): void => {
    writeRaw(JSON.stringify(msg) + "\n");
  };
  const handleLine = async (line: string): Promise<void> => {
    const response = await dispatcher.handleMessage(line);
    if (response !== undefined) write(response);
  };

  const decoder = new StringDecoder("utf8");
  let buffer = "";
  for await (const chunk of stdin) {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) await handleLine(line);
      nl = buffer.indexOf("\n");
    }
  }
  const rest = (buffer + decoder.end()).trim();
  if (rest) await handleLine(rest);
}
