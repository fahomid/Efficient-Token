import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Run a read-only git command in `cwd` and return stdout (no shell). */
export async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 20_000,
    windowsHide: true,
    encoding: "utf8",
  });
  return stdout;
}

/** True if the git command exits 0 (used for `rev-parse` probes). */
export async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await runGit(cwd, args);
    return true;
  } catch {
    return false;
  }
}

/** A user-supplied ref is safe if non-empty and not an option flag. */
export function isSafeRef(ref: string): boolean {
  return ref.trim() !== "" && !ref.startsWith("-");
}
