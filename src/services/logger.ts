/**
 * stderr-only logger. stdout is the MCP JSON-RPC stream — a stray write there
 * corrupts the transport and the host disconnects, so logging NEVER uses it.
 */
export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

function fmt(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack ?? v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function write(level: string, msg: string, args: unknown[]): void {
  const tail = args.length > 0 ? ` ${args.map(fmt).join(" ")}` : "";
  process.stderr.write(`[efficient-token] ${level} ${msg}${tail}\n`);
}

export function createLogger(): Logger {
  return {
    info: (msg, ...args) => write("INFO", msg, args),
    warn: (msg, ...args) => write("WARN", msg, args),
    error: (msg, ...args) => write("ERROR", msg, args),
  };
}
