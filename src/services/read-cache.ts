/**
 * Per-session memory of what each distilled read last returned, so an opt-in
 * repeat read of unchanged content can collapse to a short marker instead of
 * resending the bytes (incremental reads). The server process lives for the whole
 * session, so this persists across tool calls like the savings ledger.
 *
 * It is a pure optimization and never lossy by surprise: elision happens only
 * when the caller opts in (per call), any change to the content returns the full
 * bytes again (the fingerprint differs), and the marker always states how to get
 * the source back — so a context that no longer holds the earlier bytes can
 * simply re-read without the flag.
 */
export class ReadCache {
  private readonly seen = new Map<string, number>();
  private static readonly MAX = 1024;

  /** Whether `key` was already recorded with this exact fingerprint. */
  has(key: string, fp: number): boolean {
    return this.seen.get(key) === fp;
  }

  /** Record (or refresh, as most-recent) the fingerprint last returned for `key`. */
  record(key: string, fp: number): void {
    if (this.seen.has(key)) this.seen.delete(key);
    this.seen.set(key, fp);
    if (this.seen.size > ReadCache.MAX) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}
