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

/** Common `type` aliases (à la ripgrep/Claude Grep) -> file extensions. */
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
    const exts = opts.exts ? new Set(opts.exts.map((e) => e.toLowerCase())) : undefined;
    const match = opts.glob ? compileGlob(opts.glob) : undefined;
    const max = opts.maxFiles ?? 5000;

    const st = await statSafe(rootAbs);
    if (st?.isFile()) {
      const rel = this.paths.relative(rootAbs);
      const files = include(rel, exts, match) ? [{ abs: rootAbs, rel }] : [];
      return { files, truncated: false };
    }

    const out: ScannedFile[] = [];
    const truncated = await this.walk(rootAbs, exts, match, max, out);
    return { files: out, truncated };
  }

  /** Pre-order, name-sorted DFS. Returns true if the `max` cap was hit. */
  private async walk(
    dir: string,
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
        if (await this.walk(abs, exts, match, max, out)) return true;
      } else if (e.isFile()) {
        const rel = this.paths.relative(abs);
        if (include(rel, exts, match)) out.push({ abs, rel });
      }
    }
    return out.length >= max;
  }
}

function include(
  rel: string,
  exts: Set<string> | undefined,
  match: ((rel: string) => boolean) | undefined,
): boolean {
  if (exts) {
    const dot = rel.lastIndexOf(".");
    const ext = dot === -1 ? "" : rel.slice(dot + 1).toLowerCase();
    if (!exts.has(ext)) return false;
  }
  if (match && !match(rel)) return false;
  return true;
}

async function statSafe(p: string): Promise<import("node:fs").Stats | undefined> {
  try {
    return await fsp.stat(p);
  } catch {
    return undefined;
  }
}

/**
 * Compile a glob into a matcher. A glob without `/` matches the file's BASENAME
 * (so `*.ts` matches at any depth, like ripgrep); a glob with `/` matches the
 * full workspace-relative path. Supports `**`, `*`, `?`, `{a,b}`, and `[...]`.
 */
export function compileGlob(glob: string): (rel: string) => boolean {
  const basenameOnly = !glob.includes("/");
  const re = new RegExp(`^${globToRegExpSource(glob)}$`);
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
        re += glob.slice(i, end + 1); // character class, passed through
        i = end;
      }
    } else {
      re += escapeRegExp(c);
    }
  }
  return re;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
