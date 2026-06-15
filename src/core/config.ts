import { realpathSync } from "node:fs";
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
   * Tool bundles to register. `undefined` means all (no filtering). When set,
   * only plugins whose `group` is in this set load. This lets a project shed the
   * per-turn description cost of bundles it never uses (e.g. set to "core" in a
   * pure-code repo to drop the "design" media tools).
   */
  readonly groups?: ReadonlySet<string>;
}

/**
 * Canonicalize a path: resolve 8.3 short names, symlinks, and drive-letter
 * casing. SafeFs realpath-checks every target against the root, so a non-canonical
 * root (a symlinked project dir, or a short-form temp dir such as the CI runner's
 * RUNNER~1) would otherwise make in-root files look like they escape. Falls back
 * to the input when the path does not exist yet.
 */
function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
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
  const root = canonicalize(rawRoot ? path.resolve(rawRoot) : process.cwd());
  const rawGroups = process.env.EFFICIENT_TOKEN_GROUPS?.trim();
  const parsedGroups = rawGroups
    ? new Set(rawGroups.split(",").map((g) => g.trim().toLowerCase()).filter(Boolean))
    : undefined;
  // A delimiter-only value (e.g. ",") parses to an empty set. Treat that as
  // unset (load all) rather than "enable nothing", so it can't silently drop
  // tools.
  const groups = parsedGroups && parsedGroups.size > 0 ? parsedGroups : undefined;
  return {
    root,
    maxReadTokens: intFromEnv("EFFICIENT_TOKEN_MAX_READ_TOKENS", 6000),
    maxFileBytes: intFromEnv("EFFICIENT_TOKEN_MAX_FILE_BYTES", 2_000_000),
    ...(groups ? { groups } : {}),
  };
}
