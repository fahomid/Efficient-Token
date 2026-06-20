import fs from "node:fs";
import path from "node:path";

import type { Logger } from "../services/logger.js";

/** Liveness file the redirect hook stats; relative to the project's `.claude`. */
export const HEARTBEAT_REL = path.join(".claude", ".efficient-token.alive");
const INTERVAL_MS = 30_000;
/** Coalesce on-demand flushes to at most one write per this interval. */
const MIN_FLUSH_MS = 1_000;

export interface Heartbeat {
  /** Stop the timer and remove the file (clean shutdown). */
  stop: () => void;
  /** Write the latest status now (coalesced), so the status line is fresh
   *  between liveness ticks. Best-effort; safe to call on every read. */
  flush: () => void;
}

/**
 * Best-effort liveness heartbeat for the opt-in enforcement hook.
 * Touches `<dir>/.claude/.efficient-token.alive` on start and every 30s so the
 * PreToolUse redirect hook can tell the server is running; if the file is stale or
 * missing the hook fails open (the built-in tools work normally). `flush()` writes
 * the current status on demand (coalesced to one write per second) so the status
 * line reflects fresh savings between ticks. This never throws — a read-only or
 * missing filesystem must not crash the server. Disabled by `EFFICIENT_TOKEN_ENFORCE=0`.
 */
export function startHeartbeat(dir: string, log: Logger, status?: () => unknown): Heartbeat {
  if (process.env.EFFICIENT_TOKEN_ENFORCE === "0") return { stop: () => {}, flush: () => {} };
  const beatPath = path.join(dir, HEARTBEAT_REL);

  const touch = (): void => {
    try {
      fs.mkdirSync(path.dirname(beatPath), { recursive: true });
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
      fs.writeFileSync(beatPath, body);
    } catch {
      /* best-effort: never let a filesystem error take down the server */
    }
  };

  touch();
  const timer = setInterval(touch, INTERVAL_MS);
  // Don't let the heartbeat keep the event loop alive on its own.
  if (typeof timer.unref === "function") timer.unref();
  log.info(`enforcement heartbeat: ${beatPath} (EFFICIENT_TOKEN_ENFORCE=0 to disable)`);

  // On-demand flush, coalesced so a burst of reads can't cause a write storm: write
  // immediately if it has been a while, else schedule a single trailing write.
  let lastFlush = Date.now();
  let pending: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    const wait = MIN_FLUSH_MS - (Date.now() - lastFlush);
    if (wait <= 0) {
      lastFlush = Date.now();
      touch();
    } else if (pending === undefined) {
      pending = setTimeout(() => {
        pending = undefined;
        lastFlush = Date.now();
        touch();
      }, wait);
      if (typeof pending.unref === "function") pending.unref();
    }
  };

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (pending) clearTimeout(pending);
    try {
      fs.rmSync(beatPath, { force: true });
    } catch {
      /* best-effort */
    }
  };
  return { stop, flush };
}
