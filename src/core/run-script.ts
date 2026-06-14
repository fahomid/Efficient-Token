import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  output: string;
  timedOut: boolean;
  notFound: boolean;
}

/**
 * Run `npm run <script>` and, on timeout, kill the WHOLE process tree (not just
 * the shell) so a hung script can't be orphaned: a process group + SIGKILL on
 * POSIX, `taskkill /T /F` on Windows. Output (stdout+stderr) is byte-capped.
 * The `script` name MUST be validated by the caller (it is run via a shell).
 */
export function runNpmScript(cwd: string, script: string, timeoutMs: number): Promise<RunResult> {
  return runShell(cwd, `npm run ${script}`, timeoutMs);
}

/**
 * Like {@link runNpmScript} but forwards extra args to the script after `--`
 * (e.g. a test filter). Each arg is double-quoted into the command line; the
 * CALLER MUST validate every arg against a shell-safe allowlist (no quotes,
 * `$`, backticks, `%`, `!`, or shell metacharacters) so nothing can escape the
 * quotes — this is what keeps "only package.json scripts" intact.
 */
export function runNpmScriptArgs(cwd: string, script: string, args: readonly string[], timeoutMs: number): Promise<RunResult> {
  const tail = args.length > 0 ? ` -- ${args.map((a) => `"${a}"`).join(" ")}` : "";
  return runShell(cwd, `npm run ${script}${tail}`, timeoutMs);
}

function runShell(cwd: string, commandLine: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const child = spawn(commandLine, [], {
      cwd,
      shell: true, // needed for npm(.cmd); command is built from validated parts
      windowsHide: true,
      detached: !isWin, // own process group on POSIX, so we can kill the tree
    });

    let output = "";
    let bytes = 0;
    const cap = 16 * 1024 * 1024;
    const onData = (d: Buffer): void => {
      if (bytes >= cap) return;
      const s = d.toString("utf8");
      output += s;
      bytes += s.length;
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    let timedOut = false;
    let settled = false;
    const finish = (r: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, isWin);
    }, timeoutMs);

    child.on("error", (err: NodeJS.ErrnoException) => {
      finish({ code: 1, output, timedOut, notFound: err.code === "ENOENT" });
    });
    child.on("close", (code) => {
      finish({ code: code ?? 1, output, timedOut, notFound: false });
    });
  });
}

function killTree(pid: number | undefined, isWin: boolean): void {
  if (pid === undefined) return;
  try {
    if (isWin) {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      try {
        process.kill(-pid, "SIGKILL"); // kill the whole process group
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    /* best-effort */
  }
}

/** Keep the LAST lines that fit in ~maxTokens (errors/summaries are at the end). */
export function boundedTail(text: string, maxTokens: number): string {
  const trimmed = text.replace(/\s+$/, "");
  if (trimmed === "") return "(no output)";
  const budget = maxTokens * 4;
  if (trimmed.length <= budget) return trimmed;
  const lines = trimmed.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  kept.reverse();
  return `[showing last ${kept.length} of ${lines.length} output lines]\n${kept.join("\n")}`;
}
