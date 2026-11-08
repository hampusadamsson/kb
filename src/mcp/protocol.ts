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

/**
 * The response sink. Only `write` is required; `on` lets the transport observe asynchronous stream
 * failures (EPIPE surfaces as an `error` event, never as a throw from `write`).
 */
export interface StdioSink {
  write(chunk: string): unknown;
  on?(event: "error", listener: (err: unknown) => void): unknown;
}

export interface RunServerOptions extends DispatcherHandlers {
  /** defaults to process.stdin; injectable for tests */
  stdin?: AsyncIterable<Uint8Array | string>;
  /** defaults to process.stdout; receives one compact JSON line per response and nothing else */
  stdout?: StdioSink;
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

      const hasId = "id" in message;
      // A malformed id (boolean, object, array, ...) cannot be echoed back: answering with an id the
      // client never sent makes the reply impossible to correlate, so this is a hard invalid request
      // (`id: null`, the only id we can honestly put on the wire) instead of a silent coercion.
      if (hasId && message.id !== null && typeof message.id !== "string" && typeof message.id !== "number") {
        return fail(null, ErrorCode.invalidRequest, "invalid request: id must be a string, number or null");
      }
      const id = hasId ? toId(message.id) : null;
      const isNotification = !hasId;
      if (message.jsonrpc !== "2.0") return fail(id, ErrorCode.invalidRequest, 'invalid request: jsonrpc must be "2.0"');
      const method = message.method;
      if (typeof method !== "string") return fail(id, ErrorCode.invalidRequest, "invalid request: method must be a string");
      // Notifications never get a response, not even for unknown methods.
      if (isNotification) return undefined;

      const params = isRecord(message.params) ? message.params : undefined;
      try {
        const result = await dispatch(method, params);
        // A request must always be answered. A handler that resolves to undefined (instead of
        // returning a result or throwing) would leave the client waiting forever, so report it as an
        // internal fault. Notifications were already dropped above and stay silent either way.
        if (result === undefined) return fail(id, ErrorCode.internalError, "internal error: handler produced no result");
        return ok(id, result);
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
 *
 * Returns the undo function: these are process-wide globals, so whoever redirects has to put them
 * back, or every later `console.log` in the same process (a test runner, say) silently vanishes.
 */
export function redirectStdoutToStderr(): () => void {
  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  const originalInfo = console.info;
  const toStderr = (chunk: unknown, encoding?: unknown, cb?: unknown): boolean =>
    (process.stderr.write as (...a: unknown[]) => boolean)(chunk, encoding, cb);
  process.stdout.write = toStderr as unknown as typeof process.stdout.write;
  console.log = (...args: unknown[]): void => {
    (console.error as (...a: unknown[]) => void)(...args);
  };
  console.info = (...args: unknown[]): void => {
    (console.error as (...a: unknown[]) => void)(...args);
  };
  return () => {
    process.stdout.write = originalWrite;
    console.log = originalLog;
    console.info = originalInfo;
  };
}

/**
 * Hard cap on one line that has not been terminated yet. A client streaming megabytes without a
 * newline would otherwise grow `buffer` until the process dies, so past this size the line is
 * discarded (through its newline) and reported as a parse error.
 */
const MAX_LINE_LENGTH = 8 * 1024 * 1024;

/**
 * Hard cap on concurrently running dispatches. Every tool call may spawn a process, so a pipelining
 * client could otherwise start one handler per line and exhaust the machine; past this many the
 * read loop simply stops reading until a handler settles (backpressure, not a reordering queue).
 */
export const MAX_INFLIGHT = 8;

/**
 * How long shutdown waits for in-flight handlers after stdin closes. A handler that never settles
 * must not keep the process alive forever, so past this the remaining ones are abandoned.
 */
export const DRAIN_DEADLINE_MS = 5000;

/** The answer to a line we refuse to buffer (or refused to parse) because it is too long. */
const tooLong = (): JsonRpcFailure => fail(null, ErrorCode.parseError, "parse error: line too long");

/** Resolves true once `promise` settles (either way), false if that takes longer than `ms`. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      promise.then(
        () => true as const,
        () => true as const,
      ),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  const logStderr = (line: string): void => {
    try {
      (process.stderr.write as (...a: unknown[]) => boolean)(line);
    } catch {
      // stderr is gone too; nowhere left to report to.
    }
  };
  const dispatcher = createDispatcher(opts);

  // Only own the real stdout. An injected `stdout` (tests, embedding) belongs to the caller, and
  // rewriting the process's stdout on its behalf would leak out of this call and never be undone.
  const restoreStdout = opts.stdout === undefined ? redirectStdoutToStderr() : undefined;

  // A pipe the client has closed reports EPIPE as an asynchronous `error` event on the stream, not
  // as a throw from write(); with no listener that event is an uncaught exception that kills the
  // server. Mark the transport dead instead (and stop writing) so the run ends quietly.
  let dead = false;
  const onOutError = (e: unknown): void => {
    if (dead) return;
    dead = true;
    logStderr(`kb mcp: output stream failed, stopping writes: ${(e as Error)?.message ?? String(e)}\n`);
  };
  // Deliberately never detached: an EPIPE for the last write we issued can be emitted after drain()
  // returns, and an `error` event with no listener is an uncaught exception.
  if (typeof out.on === "function") out.on("error", onOutError);

  // Handlers run concurrently (a slow tool must not stall reading the next line), so the frames they
  // produce are serialised through this promise chain: two concurrent replies can never interleave.
  let writeChain: Promise<void> = Promise.resolve();
  const writeNow = (msg: unknown): void => {
    // The stream already failed: another write would only raise a second EPIPE.
    if (dead) return;
    try {
      writeRaw(JSON.stringify(msg) + "\n");
    } catch (e) {
      // A response we cannot serialise (circular structuredContent, a BigInt) or a stdout that has
      // gone away (EPIPE once the client exited) must not surface as an unhandled rejection.
      logStderr(`kb mcp: failed to write response: ${(e as Error)?.message ?? String(e)}\n`);
    }
  };
  const write = (msg: unknown): Promise<void> => {
    // writeNow never throws, so the chain can never wedge on a rejected link.
    writeChain = writeChain.then(() => writeNow(msg));
    return writeChain;
  };

  /** In-flight dispatches; drained before runServer() resolves so no reply is lost at EOF. */
  const pending = new Set<Promise<void>>();
  /** Resolves once every currently pending dispatch has settled; never rejects. */
  const settled = (): Promise<unknown> => Promise.all([...pending].map((t) => t.catch(() => {})));
  /** Resolves as soon as the first pending dispatch settles; only call with a non-empty set. */
  const anySettled = (): Promise<unknown> => Promise.race([...pending].map((t) => t.catch(() => {})));

  const atCapacity = (): boolean => !dead && pending.size >= MAX_INFLIGHT;
  const handleLine = async (line: string): Promise<void> => {
    // Backpressure: with MAX_INFLIGHT handlers already running, do not start another one — the read
    // loop waits here instead, which also stops pulling more lines off the pipe. A dead transport
    // stops nothing but the writes, so the wait is skipped there to keep shutdown moving.
    while (atCapacity()) await anySettled();
    const task = (async (): Promise<void> => {
      const response = await dispatcher.handleMessage(line);
      if (response !== undefined) await write(response);
    })();
    pending.add(task);
    // Settle-time removal; a handler bug must not take the transport down with an unhandled rejection.
    void task.then(
      () => pending.delete(task),
      (e: unknown) => {
        pending.delete(task);
        logStderr(`kb mcp: handler failed: ${(e as Error)?.message ?? String(e)}\n`);
      },
    );
  };
  const drain = async (): Promise<void> => {
    while (pending.size > 0) {
      // A handler that never settles must not turn shutdown into a hang, so the wait is capped.
      if (!(await settleWithin(settled(), DRAIN_DEADLINE_MS))) {
        logStderr(`kb mcp: drain deadline reached with ${pending.size} handler(s) still pending\n`);
        break;
      }
    }
    await writeChain;
  };

  const decoder = new StringDecoder("utf8");
  let buffer = "";
  // Set while discarding the tail of a line we already rejected for being oversized.
  let dropping = false;
  try {
    for await (const chunk of stdin) {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (dropping) {
        const end = buffer.indexOf("\n");
        buffer = end < 0 ? "" : buffer.slice(end + 1);
        dropping = end < 0;
      }
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.length > MAX_LINE_LENGTH) void write(tooLong());
        else if (line) await handleLine(line);
        nl = buffer.indexOf("\n");
      }
      // A trailing line with no newline is never parsed, so nothing bounds it without this check.
      if (buffer.length > MAX_LINE_LENGTH) {
        buffer = "";
        dropping = true;
        void write(tooLong());
      }
    }
    const rest = dropping ? "" : (buffer + decoder.end()).trim();
    if (rest) await handleLine(rest);
    // Shutdown/EOF: let every in-flight dispatch finish and flush before resolving.
    await drain();
  } finally {
    restoreStdout?.();
  }
}
