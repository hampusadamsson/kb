export type ErrorCode =
  | "not-found"
  | "ambiguous"
  | "invalid"
  | "exists"
  | "config"
  | "parse";

/** Error thrown by the core API; `code` lets a UI tell failure kinds apart. */
export class KanbanError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KanbanError";
  }
}
