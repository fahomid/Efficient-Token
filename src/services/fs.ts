import { promises as fsp } from "node:fs";
import path from "node:path";

import type { PathSandbox } from "./paths.js";

export interface ReadResult {
  /** Absolute, sandbox-validated path. */
  abs: string;
  /** Full file contents (UTF-8). */
  content: string;
  /** Line count (newline count + 1). */
  lineCount: number;
}

/**
 * Size-guarded reads and atomic writes, always through the {@link PathSandbox}.
 * Reads additionally `realpath`-check the target so a symlink cannot smuggle an
 * out-of-root file behind an in-root name.
 */
export class SafeFs {
  constructor(
    private readonly paths: PathSandbox,
    private readonly maxFileBytes: number,
  ) {}

  async exists(p: string): Promise<boolean> {
    const abs = this.paths.resolve(p);
    try {
      await fsp.access(abs);
      return true;
    } catch {
      return false;
    }
  }

  /** Read a regular file as UTF-8 with a leading BOM stripped (for display/AST). */
  async read(p: string): Promise<ReadResult> {
    return this.readImpl(p, true);
  }

  /**
   * Like {@link read} but preserves the EXACT bytes (BOM kept). Use this for
   * edits, where a faithful round-trip matters and the content is matched/rewritten
   * verbatim rather than displayed.
   */
  async readRaw(p: string): Promise<ReadResult> {
    return this.readImpl(p, false);
  }

  private async readImpl(p: string, stripBom: boolean): Promise<ReadResult> {
    const abs = this.paths.resolve(p);
    const st = await fsp.stat(abs);
    if (!st.isFile()) {
      throw new Error(`not a regular file: ${this.paths.relative(abs)}`);
    }
    if (st.size > this.maxFileBytes) {
      throw new Error(
        `file too large: ${st.size} bytes exceeds limit ${this.maxFileBytes} ` +
          `(${this.paths.relative(abs)})`,
      );
    }
    // Defense-in-depth: re-check the symlink-resolved path is still in-root.
    const real = await fsp.realpath(abs);
    this.paths.assertContained(real, this.paths.relative(abs));

    let content = await fsp.readFile(abs, "utf8");
    if (stripBom && content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    return { abs, content, lineCount: countLines(content) };
  }

  /**
   * Atomically write text: write a temp file in the SAME directory, then rename.
   * Same-dir temp keeps the rename on one filesystem so it is truly atomic.
   *
   * Symlink-safe (matching {@link SafeFs.read}): the nearest existing ancestor is
   * `realpath`-checked BEFORE `mkdir`, and the destination directory is
   * `realpath`-checked again AFTER it exists. All writes target the resolved real
   * directory, so a symlinked path component cannot escape the workspace root.
   */
  async writeAtomic(p: string, content: string): Promise<string> {
    const abs = this.paths.resolve(p);

    // 1) Pre-mkdir: a symlinked ancestor would otherwise be followed by mkdir.
    await this.assertRealAncestorContained(abs);
    await fsp.mkdir(path.dirname(abs), { recursive: true });

    // 2) Post-mkdir: the dir now exists; resolve & re-check, then target it.
    const realDir = await fsp.realpath(path.dirname(abs));
    this.paths.assertContained(realDir, this.paths.relative(abs));

    const finalAbs = path.join(realDir, path.basename(abs));
    const tmp = path.join(realDir, `.${path.basename(abs)}.${process.pid}.tmp`);
    await fsp.writeFile(tmp, content, "utf8");
    try {
      await fsp.rename(tmp, finalAbs);
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
    return finalAbs;
  }

  /** Resolve the nearest existing ancestor of `abs` and assert it is in-root. */
  private async assertRealAncestorContained(abs: string): Promise<void> {
    let dir = path.dirname(abs);
    for (;;) {
      try {
        const real = await fsp.realpath(dir);
        this.paths.assertContained(real, this.paths.relative(abs));
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        const parent = path.dirname(dir);
        if (parent === dir) throw err; // reached filesystem root, nothing in-root
        dir = parent;
      }
    }
  }
}

/** Line count == newline count + 1 (matches `content.split("\n").length`). */
function countLines(s: string): number {
  let n = 1;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) n++;
  }
  return n;
}
