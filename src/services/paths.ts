import path from "node:path";

/**
 * Confines all path resolution to the workspace root. Any path that would escape
 * the root (via `..`, or an absolute path outside it) throws. This is a purely
 * lexical guard. {@link SafeFs} adds a `realpath` check to also defeat symlinks
 * that point outside the root.
 */
export class PathSandbox {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /**
   * Resolve a user-supplied path against the root and assert containment.
   * Accepts relative paths (preferred) and absolute paths inside the root.
   */
  resolve(p: string): string {
    if (typeof p !== "string" || p.length === 0) {
      throw new Error("path must be a non-empty string");
    }
    const abs = path.resolve(this.root, p);
    // On Windows, reject NTFS alternate data streams (`file.ts::$DATA`,
    // `file.ts:stream`): a colon in the final segment is never a valid filename
    // character there, and the suffix would otherwise corrupt extension/grammar
    // detection and be echoed back as if it were a real workspace path.
    if (process.platform === "win32" && path.basename(abs).includes(":")) {
      throw new Error(`invalid path (alternate data stream): ${p}`);
    }
    this.assertContained(abs, p);
    return abs;
  }

  /** Throw unless `abs` is the root itself or strictly inside it. */
  assertContained(abs: string, original: string = abs): void {
    const rel = path.relative(this.root, abs);
    const escapes =
      rel === ".." ||
      rel.startsWith(`..${path.sep}`) ||
      path.isAbsolute(rel);
    if (escapes) {
      throw new Error(`path escapes workspace root: ${original}`);
    }
  }

  /** Path relative to root for compact output (always forward slashes). */
  relative(abs: string): string {
    const rel = path.relative(this.root, abs);
    return rel === "" ? "." : rel.split(path.sep).join("/");
  }
}
