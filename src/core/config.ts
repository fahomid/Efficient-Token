import path from "node:path";

/** Immutable runtime configuration, derived once from the environment. */
export interface Config {
  /** Absolute workspace root; all file access is confined here. */
  readonly root: string;
  /** Max tokens for a whole-file read before it degrades to an outline. */
  readonly maxReadTokens: number;
  /** Hard cap (bytes) on any file {@link SafeFs} will read. */
  readonly maxFileBytes: number;
  /**
   * Tool bundles to register. `undefined` = all (no filtering). When set, only
   * plugins whose `group` is in this set load — so a project can shed the
   * per-turn description cost of bundles it never uses (e.g. set to "core" in a
   * pure-code repo to drop the "design" media tools).
   */
  readonly groups?: ReadonlySet<string>;
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
 * - `EFFICIENT_TOKEN_GROUPS`            (default: all; comma-separated bundle names)
 */
export function loadConfig(): Config {
  const rawRoot = process.env.EFFICIENT_TOKEN_ROOT?.trim();
  const root = rawRoot ? path.resolve(rawRoot) : process.cwd();
  const rawGroups = process.env.EFFICIENT_TOKEN_GROUPS?.trim();
  const groups = rawGroups
    ? new Set(rawGroups.split(",").map((g) => g.trim().toLowerCase()).filter(Boolean))
    : undefined;
  return {
    root,
    maxReadTokens: intFromEnv("EFFICIENT_TOKEN_MAX_READ_TOKENS", 6000),
    maxFileBytes: intFromEnv("EFFICIENT_TOKEN_MAX_FILE_BYTES", 2_000_000),
    ...(groups ? { groups } : {}),
  };
}
