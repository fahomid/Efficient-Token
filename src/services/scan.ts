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
}

export interface ScanResult {
  files: ScannedFile[];
  truncated: boolean;
}

/** Directories never descended into (build output, VCS, editor, deps). */
const IGNORED_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out",
  "coverage", ".next", ".nuxt", ".turbo", ".cache", ".idea", ".vscode",
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
    const rootAbs = this.paths.resolve(opts.within ?? ".");
    // Resolve the scan root through symlinks and re-assert containment, so a
    // symlinked `within` cannot redirect enumeration outside the workspace
    // (mirrors SafeFs.read; the walk itself never follows symlinks).
    let realRoot: string;
    try {
      realRoot = await fsp.realpath(rootAbs);
    } catch {
      return { files: [], truncated: false }; // scope does not exist
    }
    this.paths.assertContained(realRoot, opts.within ?? ".");

    const exts = opts.exts ? new Set(opts.exts.map((e) => e.toLowerCase())) : undefined;
    const match = opts.glob ? compileGlob(opts.glob) : undefined;
    const max = opts.maxFiles ?? 5000;

    const st = await statSafe(realRoot);
    if (st?.isFile()) {
      const rel = this.paths.relative(realRoot);
      const files = include(rel, rel, exts, match) ? [{ abs: realRoot, rel }] : [];
      return { files, truncated: false };
    }

    const out: ScannedFile[] = [];
    const truncated = await this.walk(realRoot, realRoot, exts, match, max, out);
    return { files: out, truncated };
  }

  /** Pre-order, name-sorted DFS. Returns true if the `max` cap was hit. */
  private async walk(
    dir: string,
    scanRoot: string,
    exts: Set<string> | undefined,
    match: ((rel: string) => boolean) | undefined,
    max: number,
    out: ScannedFile[],
  ): Promise<boolean> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (out.length >= max) return true;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        if (await this.walk(abs, scanRoot, exts, match, max, out)) return true;
      } else if (e.isFile()) {
        const rel = this.paths.relative(abs);
        const relWithin = toPosix(path.relative(scanRoot, abs));
        if (include(rel, relWithin, exts, match)) out.push({ abs, rel });
      }
    }
    return out.length >= max;
  }
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
