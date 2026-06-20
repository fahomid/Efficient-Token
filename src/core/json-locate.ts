/**
 * Position-aware locator for the top-level members of a JSON object, the
 * primitive behind surgical keyed-JSON edits (json_get / json_set). It records
 * the exact character spans of each member's key and value so an edit can splice
 * a single value in place, leaving every other byte of a large file untouched.
 *
 * It assumes the input is already valid JSON (callers JSON.parse first), so the
 * scanner stays small and never has to recover from malformed input. Strings are
 * scanned with escape awareness, so a `{`, `,`, or `"` inside a value can never
 * fool the member boundaries.
 */

/** A located top-level `"key": value` member, with absolute char offsets. */
export interface JsonMember {
  /** Decoded key text (escapes resolved), for matching. */
  key: string;
  /** Index of the key's opening quote. */
  keyStart: number;
  /** Index just past the key's closing quote. */
  keyEnd: number;
  /** Index of the value's first char. */
  valueStart: number;
  /** Index just past the value's last char (no trailing whitespace). */
  valueEnd: number;
}

/** The shape of a top-level JSON object: its members and brace/indent layout. */
export interface JsonObjectShape {
  /** Index of the root `{`. */
  rootStart: number;
  /** Index just past the `{`. */
  contentStart: number;
  /** Index of the root `}`. */
  contentEnd: number;
  /** Index just past the root `}`. */
  rootEnd: number;
  /** Members in source order. */
  members: JsonMember[];
  /** Per-member indent inferred from the first member (e.g. "  "), default 2 spaces. */
  indent: string;
}

export type ShapeResult =
  | { ok: true; shape: JsonObjectShape }
  | { ok: false; reason: string };

const WS = new Set([" ", "\t", "\n", "\r"]);

function skipWs(s: string, i: number): number {
  while (i < s.length && WS.has(s[i]!)) i++;
  return i;
}

/** From the opening quote, return the index just past the closing quote. */
function skipString(s: string, i: number): number {
  i++; // past opening quote
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\\") {
      i += 2; // skip the escape and the escaped char
      continue;
    }
    if (c === '"') return i + 1;
    i++;
  }
  return i; // unterminated (not expected on valid JSON)
}

/** From an opening `{` or `[`, return the index just past the matching close. */
function skipContainer(s: string, i: number): number {
  const open = s[i]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '"') {
      i = skipString(s, i);
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return i;
}

/** From the first char of a value, return the index just past that value. */
function skipValue(s: string, i: number): number {
  const c = s[i]!;
  if (c === '"') return skipString(s, i);
  if (c === "{" || c === "[") return skipContainer(s, i);
  // number / true / false / null: run to the next structural delimiter.
  let j = i;
  while (j < s.length) {
    const d = s[j]!;
    if (WS.has(d) || d === "," || d === "}" || d === "]") break;
    j++;
  }
  return j;
}

/**
 * Infer the per-member indent from the first member that starts its own line, so
 * a file whose first member sits inline with `{` (e.g. `{"a": 1,\n    "b": 2}`)
 * still reports the real indent of its later members rather than defaulting.
 */
function inferIndent(content: string, members: JsonMember[]): string {
  for (const m of members) {
    let lineStart = m.keyStart;
    while (lineStart > 0 && content[lineStart - 1] !== "\n") lineStart--;
    const pre = content.slice(lineStart, m.keyStart);
    if (pre.length > 0 && /^[ \t]+$/.test(pre)) return pre;
  }
  return "  ";
}

/**
 * Locate the top-level object and its members. Returns `{ ok: false }` if the
 * document's root is not an object (an array or scalar has no keyed members).
 */
export function topLevelObject(content: string): ShapeResult {
  let i = 0;
  if (content.charCodeAt(0) === 0xfeff) i++; // skip a leading BOM
  i = skipWs(content, i);
  if (content[i] !== "{") {
    return { ok: false, reason: "the document's root is not a JSON object" };
  }
  const rootStart = i;
  const contentStart = i + 1;
  i = contentStart;

  const members: JsonMember[] = [];
  for (;;) {
    i = skipWs(content, i);
    if (i >= content.length) return { ok: false, reason: "unterminated object" };
    if (content[i] === "}") {
      return {
        ok: true,
        shape: { rootStart, contentStart, contentEnd: i, rootEnd: i + 1, members, indent: inferIndent(content, members) },
      };
    }
    if (content[i] !== '"') return { ok: false, reason: `expected a key at offset ${i}` };

    const keyStart = i;
    const keyEnd = skipString(content, i);
    let key: string;
    try {
      key = JSON.parse(content.slice(keyStart, keyEnd)) as string;
    } catch {
      return { ok: false, reason: `unparseable key at offset ${keyStart}` };
    }

    i = skipWs(content, keyEnd);
    if (content[i] !== ":") return { ok: false, reason: `expected ':' after key "${key}"` };
    i = skipWs(content, i + 1);
    const valueStart = i;
    const valueEnd = skipValue(content, i);
    members.push({ key, keyStart, keyEnd, valueStart, valueEnd });

    i = skipWs(content, valueEnd);
    if (content[i] === ",") {
      i++;
      continue;
    }
    if (content[i] === "}") continue; // loop top handles the close
    return { ok: false, reason: `expected ',' or '}' after value of "${key}"` };
  }
}

/** Indent every line after the first by `indent` (for multi-line serialized values). */
export function indentContinuation(text: string, indent: string): string {
  return text.replace(/\n/g, `\n${indent}`);
}
