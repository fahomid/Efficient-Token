import { promises as fsp } from "node:fs";
import path from "node:path";

import type { PathSandbox } from "./paths.js";

export interface ScannedFile {
  abs: string;
  /** Workspace-relative path, forward-slashed. */
  rel: string;
}

export interface ScanOptions {
  /** Sub-path under the workspace to scan (relative). Default: the whole root. */
  within?: string;
  /** Include only files matching this glob (basename if it has no `/`, else full rel path). */
  glob?: string;
  /** Include only files with one of these extensions (lowercase, no dot). */
  exts?: readonly string[];
  /** Stop after collecting this many files. */
  maxFiles?: number;
  /** Skip files matching {@link ScanOptions.generatedGlobs} (counted in the result). */
  skipGenerated?: boolean;
  /** Generated-file globs to skip when {@link ScanOptions.skipGenerated} is set. */
  generatedGlobs?: readonly string[];
}

export interface ScanResult {
  files: ScannedFile[];
  truncated: boolean;
  /** How many files were skipped as generated (0 unless skipGenerated). */
  skippedGenerated: number;
}

/** Directories never descended into (build output, VCS, editor, deps). */
const IGNORED_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out",
  "coverage", ".next", ".nuxt", ".turbo", ".cache", ".idea", ".vscode", ".claude",
]);

/** Common `type` aliases (like ripgrep/Claude Grep) to file extensions. */
export const TYPE_EXTS: Readonly<Record<string, readonly string[]>> = {
  ts: ["ts", "mts", "cts", "tsx"],
  tsx: ["tsx"],
  js: ["js", "mjs", "cjs", "jsx"],
  jsx: ["jsx"],
  py: ["py", "pyi"],
  python: ["py", "pyi"],
  go: ["go"],
  rust: ["rs"],
  java: ["java"],
  c: ["c", "h"],
  cpp: ["cpp", "cc", "cxx", "hpp", "hh", "hxx", "h"],
  cs: ["cs"],
  csharp: ["cs"],
  ruby: ["rb"],
  rb: ["rb"],
  php: ["php"],
  swift: ["swift"],
  kotlin: ["kt", "kts"],
  scala: ["scala", "sc"],
  json: ["json"],
  yaml: ["yaml", "yml"],
  toml: ["toml"],
  md: ["md", "markdown"],
  markdown: ["md", "markdown"],
  html: ["html", "htm"],
  css: ["css"],
  sh: ["sh", "bash", "zsh"],
  lua: ["lua"],
  zig: ["zig"],
  dart: ["dart"],
};

/**
 * Deterministic, sandboxed workspace file walker shared by search / references /
 * repo-map. Skips {@link IGNORED_DIRS}; results are pre-order, name-sorted (so a
 * given tree always enumerates identically), and capped.
 */
export class Scanner {
  constructor(private readonly paths: PathSandbox) {}

  async files(opts: ScanOptions = {}): Promise<ScanResult> {
    // A glob explicitly rooted at an ignored dir (e.g. "dist/**") is an explicit
    // request for that dir, so scope the scan to it rather than pruning it — the
    // ignore list still applies to dirs *nested* under the named root.
    const within = opts.within ?? (opts.glob !== undefined ? explicitIgnoredRoot(opts.glob) : undefined);
    const rootAbs = this.paths.resolve(within ?? ".");
    // Resolve the scan root through symlinks and re-assert containment, so a
    // symlinked `within` cannot redirect enumeration outside the workspace
    // (mirrors SafeFs.read; the walk itself never follows symlinks).
    let realRoot: string;
    try {
      realRoot = await fsp.realpath(rootAbs);
    } catch {
      return { files: [], truncated: false, skippedGenerated: 0 }; // scope does not exist
    }
    this.paths.assertContained(realRoot, within ?? ".");

    const genMatch =
      opts.skipGenerated && opts.generatedGlobs && opts.generatedGlobs.length > 0
        ? buildGenMatch(opts.generatedGlobs)
        : undefined;
    const w: WalkState = {
      scanRoot: realRoot,
      exts: opts.exts ? new Set(opts.exts.map((e) => e.toLowerCase())) : undefined,
      match: opts.glob ? compileGlob(opts.glob) : undefined,
      genMatch,
      max: opts.maxFiles ?? 5000,
      out: [],
      skipped: 0,
    };

    const st = await statSafe(realRoot);
    if (st?.isFile()) {
      const rel = this.paths.relative(realRoot);
      if (genMatch && genMatch(rel)) return { files: [], truncated: false, skippedGenerated: 1 };
      const files = include(rel, rel, w.exts, w.match) ? [{ abs: realRoot, rel }] : [];
      return { files, truncated: false, skippedGenerated: 0 };
    }

    const truncated = await this.walk(realRoot, w);
    return { files: w.out, truncated, skippedGenerated: w.skipped };
  }

  /** Pre-order, name-sorted DFS. Returns true if the `max` cap was hit. */
  private async walk(dir: string, w: WalkState): Promise<boolean> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (w.out.length >= w.max) return true;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        if (await this.walk(abs, w)) return true;
      } else if (e.isFile()) {
        const rel = this.paths.relative(abs);
        if (w.genMatch && w.genMatch(rel)) {
          w.skipped++;
          continue;
        }
        const relWithin = toPosix(path.relative(w.scanRoot, abs));
        if (include(rel, relWithin, w.exts, w.match)) w.out.push({ abs, rel });
      }
    }
    return w.out.length >= w.max;
  }
}

/** Mutable state threaded through the recursive walk. */
interface WalkState {
  scanRoot: string;
  exts: Set<string> | undefined;
  match: ((rel: string) => boolean) | undefined;
  genMatch: ((rel: string) => boolean) | undefined;
  max: number;
  out: ScannedFile[];
  skipped: number;
}

/**
 * If a glob is explicitly rooted at an ignored dir (e.g. `dist/**`, `node_modules/x/*`),
 * return its literal leading path so the walker can scope to (and descend into) that
 * named dir instead of pruning it. Returns undefined when the leading segment is not
 * an ignored dir or the glob starts with a wildcard.
 */
function explicitIgnoredRoot(glob: string): string | undefined {
  const lit: string[] = [];
  for (const seg of glob.split("/")) {
    if (/[*?[\]{}]/.test(seg)) break; // stop at the first wildcard segment
    lit.push(seg);
  }
  if (lit.length === 0 || !IGNORED_DIRS.has(lit[0]!)) return undefined;
  return lit.join("/");
}

/** Build a predicate matching a rel path against any of the generated globs. */
export function buildGenMatch(globs: readonly string[]): (rel: string) => boolean {
  const matchers = globs.map((g) => {
    try {
      return compileGlob(g);
    } catch {
      return () => false;
    }
  });
  return (rel: string) => matchers.some((m) => m(rel));
}

function include(
  rel: string,
  relWithin: string,
  exts: Set<string> | undefined,
  match: ((rel: string) => boolean) | undefined,
): boolean {
  if (exts) {
    const dot = rel.lastIndexOf(".");
    const ext = dot === -1 ? "" : rel.slice(dot + 1).toLowerCase();
    if (!exts.has(ext)) return false;
  }
  // A slash-glob matches the workspace-relative path, or, when the scan is
  // scoped to a sub-path, the path relative to that scope. This keeps a scoped
  // glob like { path: "src", pattern: "lib/*.ts" } from being anchored to root.
  if (match && !match(rel) && (relWithin === rel || !match(relWithin))) return false;
  return true;
}

function toPosix(p: string): string {
  return path.sep === "/" ? p : p.split(path.sep).join("/");
}

async function statSafe(p: string): Promise<import("node:fs").Stats | undefined> {
  try {
    return await fsp.stat(p);
  } catch {
    return undefined;
  }
}

/**
 * Compile a glob into a matcher. A glob without `/` matches the file's basename,
 * so `*.ts` matches at any depth, like ripgrep. A glob with `/` matches the full
 * workspace-relative path. Supports `**`, `*`, `?`, `{a,b}`, and `[...]`.
 */
export function compileGlob(glob: string): (rel: string) => boolean {
  const basenameOnly = !glob.includes("/");
  // Match the way the underlying filesystem resolves names: case-insensitive on
  // Windows/macOS (so `README*` finds `readme.md`), case-sensitive on Linux.
  const ciFs = process.platform === "win32" || process.platform === "darwin";
  let re: RegExp;
  try {
    re = new RegExp(`^${globToRegExpSource(glob)}$`, ciFs ? "i" : "");
  } catch {
    // A glob whose character class is invalid JS regex (e.g. a reversed range
    // `[z-a]`) must surface as a clean "invalid glob", never leak regex internals.
    throw new Error(`invalid glob pattern: ${JSON.stringify(glob)}`);
  }
  return (rel: string): boolean => {
    const target = basenameOnly ? (rel.split("/").pop() ?? rel) : rel;
    return re.test(target);
  };
}

function globToRegExpSource(glob: string): string {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?"; // **/ -> zero or more path segments
          i += 2;
        } else {
          re += ".*"; // ** -> anything (crosses /)
          i += 1;
        }
      } else {
        re += "[^/]*"; // * -> anything but /
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
      } else {
        const alts = glob.slice(i + 1, end).split(",").map(escapeRegExp).join("|");
        re += `(?:${alts})`;
        i = end;
      }
    } else if (c === "[") {
      const end = glob.indexOf("]", i);
      if (end === -1) {
        re += "\\[";
      } else {
        // Glob negation is `[!...]`; JS regex negation is `[^...]`. Translate so
        // `[!_]*.ts` means "not starting with _" rather than matching a literal !.
        let body = glob.slice(i + 1, end);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        re += `[${body}]`;
        i = end;
      }
    } else {
      re += escapeRegExp(c);
    }
  }
  return re;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A regex matching `name` only at identifier boundaries. It is Unicode-aware, so
 * it won't match an ASCII substring inside a larger identifier (e.g. `caf` inside
 * `café`). `\p{ID_Continue}` covers letters/digits/underscore/combining marks
 * across languages; `$` is added explicitly, since it is valid in JS identifiers.
 * The caller passes extra flags (e.g. "g", "gi"); the `u` flag is always added.
 */
export function identifierBoundary(name: string, flags = ""): RegExp {
  return new RegExp(`(?<![\\p{ID_Continue}$])${escapeRegExp(name)}(?![\\p{ID_Continue}$])`, `${flags}u`);
}
