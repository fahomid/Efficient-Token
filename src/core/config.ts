import path from "node:path";

/** Immutable runtime configuration, derived once from the environment. */
export interface Config {
  /** Absolute workspace root; all file access is confined here. */
  readonly root: string;
  /** Max tokens for a whole-file read before it degrades to an outline. */
  readonly maxReadTokens: number;
  /** Hard cap (bytes) on any file {@link SafeFs} will read. */
  readonly maxFileBytes: number;
}

/** Parse a positive integer env var, falling back on missing/invalid input. */
function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Build config from the environment:
 * - `EFFICIENT_TOKEN_ROOT`              (default: cwd)
 * - `EFFICIENT_TOKEN_MAX_READ_TOKENS`   (default: 6000)
 * - `EFFICIENT_TOKEN_MAX_FILE_BYTES`    (default: 2_000_000)
 */
export function loadConfig(): Config {
  const rawRoot = process.env.EFFICIENT_TOKEN_ROOT?.trim();
  const root = rawRoot ? path.resolve(rawRoot) : process.cwd();
  return {
    root,
    maxReadTokens: intFromEnv("EFFICIENT_TOKEN_MAX_READ_TOKENS", 6000),
    maxFileBytes: intFromEnv("EFFICIENT_TOKEN_MAX_FILE_BYTES", 2_000_000),
  };
}
