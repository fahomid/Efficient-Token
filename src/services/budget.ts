/**
 * Cheap, dependency-free token estimator. Uses the common ~4-chars-per-token
 * heuristic. This is deliberately an estimate, not a tokenizer, which avoids
 * per-model coupling and an extra dependency. Used only to decide when a
 * whole-file read degrades.
 */
export class TokenBudgeter {
  /** Estimated token count for `text`. */
  estimate(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /** True if `text` is estimated to fit within `maxTokens`. */
  fits(text: string, maxTokens: number): boolean {
    return this.estimate(text) <= maxTokens;
  }
}
