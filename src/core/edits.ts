/**
 * Pure, literal exact-string replacement: the shared primitive behind
 * `code_edit` and `apply_patch`. Avoids `String.replace`, which would interpret
 * `$&`/`$1` in the replacement. Matching and uniqueness mirror Claude's `Edit`.
 */

export type EditResult =
  | { ok: true; content: string; count: number }
  | { ok: false; reason: "empty" | "identical" | "not-found" | "ambiguous"; matches: number };

export function applyStringEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): EditResult {
  if (oldString.length === 0) return { ok: false, reason: "empty", matches: 0 };
  if (oldString === newString) return { ok: false, reason: "identical", matches: 0 };

  const count = countOccurrences(content, oldString);
  if (count === 0) return { ok: false, reason: "not-found", matches: 0 };
  if (count > 1 && !replaceAll) return { ok: false, reason: "ambiguous", matches: count };

  if (replaceAll) {
    return { ok: true, content: content.split(oldString).join(newString), count };
  }
  const i = content.indexOf(oldString);
  return {
    ok: true,
    content: content.slice(0, i) + newString + content.slice(i + oldString.length),
    count: 1,
  };
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
