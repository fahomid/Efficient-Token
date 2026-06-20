import fs from "node:fs";
import path from "node:path";

/**
 * Read the server's health from the heartbeat status file — no MCP/API call, no
 * model turn. Powers `efficient-token status`: by default it prints the full,
 * health-style report (version, tier, root, limits, session savings); `--line`
 * prints a compact one-liner for Claude Code's `statusLine`, and `--json` the raw
 * data. The running server writes the file every 30s; here we only read it, and
 * never throw (a status line must always print something).
 */

/** A heartbeat older than this is treated as "not running" (2 missed beats). */
const STALE_MS = 60_000;

export interface ServerStatus {
  up: boolean;
  ageMs?: number;
  /** How many live server instances were aggregated (>1 means multiple sessions). */
  servers?: number;
  version?: string;
  pid?: number;
  tier?: string;
  root?: string;
  maxReadTokens?: number;
  maxFileBytes?: number;
  calls?: number;
  returnedTokens?: number;
  baselineTokens?: number;
  savedTokens?: number;
}

/**
 * Aggregate every live per-PID heartbeat under `<projectRoot>/.claude/.efficient-token/`
 * (plus the legacy single file, for compatibility). Each server process writes its
 * own file, so multiple servers on one project never clobber each other; here we sum
 * the savings of the live (fresh-mtime) ones and take the meta from the freshest.
 * Never throws.
 */
export function readStatus(projectRoot: string): ServerStatus {
  const dir = path.join(projectRoot, ".claude", ".efficient-token");
  const candidates: string[] = [];
  try {
    for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) candidates.push(path.join(dir, f));
  } catch {
    /* the dir may not exist */
  }
  candidates.push(path.join(projectRoot, ".claude", ".efficient-token.alive")); // legacy single file

  const now = Date.now();
  const live: Array<{ data: Record<string, unknown>; ageMs: number }> = [];
  let freshestStale: number | undefined;
  for (const file of candidates) {
    let ageMs: number;
    try {
      ageMs = now - fs.statSync(file).mtimeMs;
    } catch {
      continue; // missing
    }
    if (ageMs > STALE_MS) {
      if (freshestStale === undefined || ageMs < freshestStale) freshestStale = ageMs;
      continue;
    }
    let data: Record<string, unknown> = {};
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw && typeof raw === "object") data = raw as Record<string, unknown>;
    } catch {
      /* an older/plain-timestamp heartbeat: still "up", just no detail */
    }
    live.push({ data, ageMs });
  }

  if (live.length === 0) return freshestStale === undefined ? { up: false } : { up: false, ageMs: freshestStale };

  live.sort((a, b) => a.ageMs - b.ageMs); // freshest first
  const f = live[0]!.data;
  const str = (k: string): string | undefined => (typeof f[k] === "string" ? (f[k] as string) : undefined);
  const num = (k: string): number | undefined => (typeof f[k] === "number" ? (f[k] as number) : undefined);
  const sum = (k: string): number => live.reduce((n, x) => n + (typeof x.data[k] === "number" ? (x.data[k] as number) : 0), 0);
  return {
    up: true,
    ageMs: live[0]!.ageMs,
    servers: live.length,
    version: str("v"),
    pid: num("pid"),
    tier: str("tier"),
    root: str("root"),
    maxReadTokens: num("maxReadTokens"),
    maxFileBytes: num("maxFileBytes"),
    calls: sum("calls"),
    returnedTokens: sum("returnedTokens"),
    baselineTokens: sum("baselineTokens"),
    savedTokens: sum("savedTokens"),
  };
}

/** Compact token count, e.g. 12345 -> "12.3k". */
function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Round saved/baseline into a percent, or undefined if not computable. */
function savedPct(s: ServerStatus): number | undefined {
  if (s.savedTokens === undefined || !s.baselineTokens || s.baselineTokens <= 0) return undefined;
  return Math.round((s.savedTokens / s.baselineTokens) * 100);
}

/** Compact one-line health summary, for a status line. */
export function formatStatus(s: ServerStatus): string {
  if (!s.up) return "efficient-token: not running";
  const ver = s.version ? ` v${s.version}` : "";
  const tier = s.tier ? ` (${s.tier})` : "";
  let usage = "";
  if (s.baselineTokens !== undefined && s.returnedTokens !== undefined) {
    const pct = savedPct(s);
    usage = ` · ${compact(s.baselineTokens)} token read and passed ${compact(s.returnedTokens)} token to Claude${pct !== undefined ? ` (~${pct}% less)` : ""}`;
  } else if (s.savedTokens !== undefined) {
    usage = ` · saved ~${compact(s.savedTokens)} tok`;
  }
  const multi = (s.servers ?? 1) > 1 ? ` · ${s.servers} servers` : "";
  return `efficient-token${ver}${tier}: up${usage}${multi}`;
}

/** Full, health-style multi-line report (the default for `efficient-token status`). */
export function formatDetailed(s: ServerStatus): string {
  if (!s.up) {
    const age = s.ageMs !== undefined ? ` (last heartbeat ${Math.round(s.ageMs / 1000)}s ago — stale)` : " (no heartbeat found)";
    return `efficient-token: not running${age}`;
  }
  const lines = ["efficient-token: up"];
  if (s.version) lines.push(`version: ${s.version}`);
  if (s.tier) lines.push(`tier: ${s.tier}`);
  if (s.root) lines.push(`root: ${s.root}`);
  if ((s.servers ?? 1) > 1) lines.push(`live servers: ${s.servers} (savings summed across sessions on this project)`);
  if (s.maxReadTokens !== undefined) lines.push(`maxReadTokens: ${s.maxReadTokens}`);
  if (s.maxFileBytes !== undefined) lines.push(`maxFileBytes: ${s.maxFileBytes}`);
  if (s.savedTokens !== undefined || s.returnedTokens !== undefined || s.calls !== undefined) {
    const pct = savedPct(s) ?? 0;
    lines.push("savings this session (estimate):");
    lines.push(`  efficient-token read ~${s.baselineTokens ?? 0} tokens of source and passed ~${s.returnedTokens ?? 0} to Claude — ~${pct}% fewer (${s.calls ?? 0} read(s))`);
    lines.push(`  saved ~${s.savedTokens ?? 0} tokens`);
  }
  if (s.ageMs !== undefined) lines.push(`last heartbeat: ${Math.round(s.ageMs / 1000)}s ago`);
  return lines.join("\n");
}

/** CLI entry for `efficient-token status [--line|--json]`. Always exits 0. */
export function runStatusCli(args: string[]): number {
  const root = process.env.CLAUDE_PROJECT_DIR?.trim() || process.cwd();
  try {
    const s = readStatus(root);
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(s)}\n`);
    else if (args.includes("--line") || args.includes("--oneline")) process.stdout.write(`${formatStatus(s)}\n`);
    else process.stdout.write(`${formatDetailed(s)}\n`);
  } catch {
    // A status line must never fail — print a safe fallback instead.
    process.stdout.write("efficient-token: not running\n");
  }
  return 0;
}
