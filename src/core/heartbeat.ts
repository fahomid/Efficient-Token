import fs from "node:fs";
import path from "node:path";

import type { Logger } from "../services/logger.js";

/** Per-server heartbeat dir; each server process writes `<pid>.json` inside it. */
export const HEARTBEAT_DIR_REL = path.join(".claude", ".efficient-token");
/** Legacy single-file path (pre-1.0.5); readers still honor it for compatibility. */
export const HEARTBEAT_LEGACY_REL = path.join(".claude", ".efficient-token.alive");
const INTERVAL_MS = 30_000;
/** Coalesce on-demand flushes to at most one write per this interval. */
const MIN_FLUSH_MS = 1_000;
/** On startup, drop sibling heartbeats older than this (a crashed/closed session). */
const PRUNE_MAX_AGE_MS = 5 * 60_000;

export interface Heartbeat {
  /** Stop the timer and remove this server's heartbeat file (clean shutdown). */
  stop: () => void;
  /** Write the latest status now (coalesced), so the status line is fresh
   *  between liveness ticks. Best-effort; safe to call on every read. */
  flush: () => void;
}

/**
 * Best-effort liveness + status heartbeat for the opt-in enforcement hook and the
 * status line. Each server process writes its OWN file
 * `<dir>/.claude/.efficient-token/<pid>.json` — never a shared file — so multiple
 * servers on one project (a duplicate registration, two windows, or an orphaned
 * process from a closed terminal) cannot clobber each other; readers aggregate the
 * live (fresh-mtime) files. The file carries a small status JSON so a status line
 * can show health without an API call. `flush()` writes on demand (coalesced to one
 * write per second) so the status reflects fresh savings between the 30s ticks.
 * Never throws — a read-only or missing filesystem must not crash the server.
 * Disabled by `EFFICIENT_TOKEN_ENFORCE=0`.
 */
export function startHeartbeat(dir: string, log: Logger, status?: () => unknown): Heartbeat {
  if (process.env.EFFICIENT_TOKEN_ENFORCE === "0") return { stop: () => {}, flush: () => {} };
  const hbDir = path.join(dir, HEARTBEAT_DIR_REL);
  const beatPath = path.join(hbDir, `${process.pid}.json`);

  const touch = (): void => {
    try {
      fs.mkdirSync(hbDir, { recursive: true });
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

  // Drop sibling heartbeats from long-dead sessions so files don't accumulate.
  try {
    for (const f of fs.readdirSync(hbDir)) {
      if (!f.endsWith(".json")) continue;
      const p = path.join(hbDir, f);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > PRUNE_MAX_AGE_MS) fs.rmSync(p, { force: true });
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* the dir may not exist yet */
  }

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
