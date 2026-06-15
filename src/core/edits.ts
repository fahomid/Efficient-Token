/**
 * Pure, literal exact-string replacement: the shared primitive behind
 * `code_edit` and `apply_patch`. Avoids `String.replace`, which would interpret
 * `$&`/`$1` in the replacement. Matching and uniqueness mirror Claude's `Edit`.
 *
 * Matching is byte-for-byte first, so an edit never changes anything outside the
 * span it matched. When that exact match fails and the anchor spans lines, it
 * retries with the anchor re-cast to the file's own newline style — so an `\n`
 * anchor still matches a file saved with `\r\n` (or vice versa), the way Claude's
 * `Edit` does. Only the matched region is rewritten; the file keeps its existing
 * line endings everywhere else.
 */

export type EditResult =
  | { ok: true; content: string; count: number; firstIndex: number; newText: string }
  | { ok: false; reason: "empty" | "identical" | "not-found" | "ambiguous"; matches: number };

export function applyStringEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): EditResult {
  if (oldString.length === 0) return { ok: false, reason: "empty", matches: 0 };
  if (oldString === newString) return { ok: false, reason: "identical", matches: 0 };

  // Fast path: exact, byte-for-byte match — fully faithful.
  const exact = splice(content, oldString, newString, replaceAll);
  if (exact.ok || exact.reason === "ambiguous") return exact;

  // Fallback: a multi-line anchor whose newline style differs from the file's
  // (typically an LF anchor against a CRLF-saved file). Re-cast the anchor and
  // the replacement to the file's newline style and retry, dominant style first.
  if (oldString.includes("\n")) {
    const tried = new Set<string>([oldString]);
    for (const eol of orderedEols(content)) {
      const recastOld = setEol(oldString, eol);
      if (tried.has(recastOld)) continue;
      tried.add(recastOld);
      const alt = splice(content, recastOld, setEol(newString, eol), replaceAll);
      if (alt.ok || alt.reason === "ambiguous") return alt;
    }
  }
  return exact; // not-found, reported against the verbatim anchor
}

/** Literal find-and-replace with Claude's match/uniqueness rules. */
function splice(content: string, oldString: string, newString: string, replaceAll: boolean): EditResult {
  const count = countOccurrences(content, oldString);
  if (count === 0) return { ok: false, reason: "not-found", matches: 0 };
  if (count > 1 && !replaceAll) return { ok: false, reason: "ambiguous", matches: count };

  const firstIndex = content.indexOf(oldString);
  if (replaceAll) {
    return { ok: true, content: content.split(oldString).join(newString), count, firstIndex, newText: newString };
  }
  return {
    ok: true,
    content: content.slice(0, firstIndex) + newString + content.slice(firstIndex + oldString.length),
    count: 1,
    firstIndex,
    newText: newString,
  };
}

/** Re-cast every newline in `s` to `eol` (collapse CRLF→LF first, so it is idempotent). */
function setEol(s: string, eol: "\n" | "\r\n"): string {
  const lf = s.replace(/\r\n/g, "\n");
  return eol === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf;
}

/** The file's newline styles, dominant one first, so the likely match is tried first. */
function orderedEols(content: string): Array<"\n" | "\r\n"> {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const lfOnly = (content.match(/\n/g) ?? []).length - crlf;
  return crlf > lfOnly ? ["\r\n", "\n"] : ["\n", "\r\n"];
}

/** A human-readable reason for a failed {@link applyStringEdit}. */
export function editFailureMessage(rel: string, r: Extract<EditResult, { ok: false }>): string {
  switch (r.reason) {
    case "empty":
      return `${rel} — old_string must not be empty.`;
    case "identical":
      return `${rel} — old_string and new_string are identical; nothing to change.`;
    case "not-found":
      return `${rel} — old_string not found. Read the file and copy the exact text, including whitespace.`;
    case "ambiguous":
      return `${rel} — old_string is not unique (${r.matches} matches). Add surrounding context to disambiguate, or set replace_all=true.`;
  }
}

/** Count non-overlapping literal occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}
