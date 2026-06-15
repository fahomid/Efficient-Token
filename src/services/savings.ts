/**
 * In-session ledger of tokens saved by distilling reads. The MCP server process
 * lives for the whole session, so this accumulates across tool calls and is
 * reported by `health`.
 *
 * It only records cases where the baseline is exact and honest: a tool that read
 * a full file (or git blob) but returned less. `baselineChars` is what the
 * built-in Read would have returned (the whole file); `returnedChars` is what we
 * actually returned. Saved is baseline minus returned, clamped at 0, so a
 * whole-file read that fits saves about nothing (correctly near 0, never
 * negative). Token counts use the same ~4-chars/token estimate as
 * {@link TokenBudgeter}; this is an estimate, not a per-model tokenizer.
 */
export interface SavingsReport {
  calls: number;
  baselineTokens: number;
  returnedTokens: number;
  savedTokens: number;
  /** Per-source breakdown (e.g. "read", "outline"). */
  byKind: Record<string, { calls: number; savedTokens: number }>;
}

export class SavingsLedger {
  private calls = 0;
  private baselineChars = 0;
  private returnedChars = 0;
  private readonly kinds = new Map<string, { calls: number; saved: number }>();

  /** Record one distilled read. `returnedChars` is clamped to the baseline. */
  record(kind: string, baselineChars: number, returnedChars: number): void {
    if (!Number.isFinite(baselineChars) || baselineChars <= 0) return;
    const returned = Math.max(0, Math.min(returnedChars, baselineChars));
    this.calls += 1;
    this.baselineChars += baselineChars;
    this.returnedChars += returned;
    const k = this.kinds.get(kind) ?? { calls: 0, saved: 0 };
    k.calls += 1;
    k.saved += baselineChars - returned;
    this.kinds.set(kind, k);
  }

  report(): SavingsReport {
    const tok = (chars: number): number => Math.ceil(chars / 4);
    const byKind: Record<string, { calls: number; savedTokens: number }> = {};
    for (const [k, v] of this.kinds) byKind[k] = { calls: v.calls, savedTokens: tok(v.saved) };
    return {
      calls: this.calls,
      baselineTokens: tok(this.baselineChars),
      returnedTokens: tok(this.returnedChars),
      savedTokens: tok(Math.max(0, this.baselineChars - this.returnedChars)),
      byKind,
    };
  }
}
