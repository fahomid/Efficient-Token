import type { SymbolInfo } from "../services/ast.js";

/**
 * Map each changed file to its NEW-side changed line ranges, parsed from a
 * unified diff produced with `--unified=0` (one `@@` hunk per change). Shared by
 * `review_branch` (changed symbols) and `change_coverage` (changed lines ∩
 * coverage). Paths are the diff's `b/` paths (workspace-relative, forward-slash).
 */
export function parseChangedRanges(diff: string): Map<string, Array<[number, number]>> {
  const map = new Map<string, Array<[number, number]>>();
  let cur: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      cur = p === "/dev/null" ? null : p.startsWith("b/") ? p.slice(2) : p;
      if (cur && !map.has(cur)) map.set(cur, []);
    } else if (cur && line.startsWith("@@")) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      if (m) {
        const c = Number(m[1]);
        const d = m[2] === undefined ? 1 : Number(m[2]);
        if (d > 0) map.get(cur)!.push([c, c + d - 1]);
      }
    }
  }
  return map;
}

/** Expand changed ranges to a set of individual new-side line numbers (capped). */
export function changedLineSet(ranges: ReadonlyArray<[number, number]>, cap = 100_000): Set<number> {
  const set = new Set<number>();
  for (const [c, e] of ranges) {
    for (let L = c; L <= e; L++) {
      set.add(L);
      if (set.size >= cap) return set;
    }
  }
  return set;
}

/** The innermost outline symbol whose [startLine,endLine] contains `lineNo`. */
export function enclosingSymbol(outline: readonly SymbolInfo[], lineNo: number): SymbolInfo | undefined {
  let best: SymbolInfo | undefined;
  for (const s of outline) {
    if (s.startLine <= lineNo && lineNo <= s.endLine) {
      if (!best || s.startLine > best.startLine) best = s;
    }
  }
  return best;
}
