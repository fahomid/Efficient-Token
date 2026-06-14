import type { ToolResult } from "./contract.js";

/** A successful tool result carrying one text block. */
export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** A failed tool result. `isError` lets the host surface it as a tool failure. */
export function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Best-effort human-readable message from an unknown thrown value. */
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
