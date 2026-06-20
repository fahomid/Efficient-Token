import fs from "node:fs";
import path from "node:path";

import type { Logger } from "../services/logger.js";

/** Liveness file the redirect hook stats; relative to the project's `.claude`. */
export const HEARTBEAT_REL = path.join(".claude", ".efficient-token.alive");
const INTERVAL_MS = 30_000;

/**
 * Best-effort liveness heartbeat for the opt-in enforcement hook.
 * Touches `<dir>/.claude/.efficient-token.alive` on start and every 30s so the
 * PreToolUse redirect hook can tell the server is running; if the file is stale or
 * missing the hook fails open (the built-in tools work normally). This never
 * throws — a read-only or missing filesystem must not crash the server. Disabled
 * by `EFFICIENT_TOKEN_ENFORCE=0`. Returns a stop() that clears the timer and, on a
 * clean shutdown, removes the file.
 */
export function startHeartbeat(dir: string, log: Logger, status?: () => unknown): () => void {
  if (process.env.EFFICIENT_TOKEN_ENFORCE === "0") return () => {};
  const beat = path.join(dir, HEARTBEAT_REL);

  const touch = (): void => {
    try {
      fs.mkdirSync(path.dirname(beat), { recursive: true });
      // The enforcement hook only reads the mtime, but a small status JSON lets an
      // out-of-process reader (e.g. a status line) show health without an API call.
      let body = String(Date.now());
      if (status) {
        try {
          body = JSON.stringify(status());
        } catch {
          /* fall back to a bare timestamp */
        }
      }
      fs.writeFileSync(beat, body);
    } catch {
      /* best-effort: never let a filesystem error take down the server */
    }
  };

  touch();
  const timer = setInterval(touch, INTERVAL_MS);
  // Don't let the heartbeat keep the event loop alive on its own.
  if (typeof timer.unref === "function") timer.unref();
  log.info(`enforcement heartbeat: ${beat} (EFFICIENT_TOKEN_ENFORCE=0 to disable)`);

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    try {
      fs.rmSync(beat, { force: true });
    } catch {
      /* best-effort */
    }
  };
}
