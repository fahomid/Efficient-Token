/**
 * Render lines with right-aligned line numbers, e.g.:
 * ```
 *   9| const x = 1;
 *  10| const y = 2;
 * ```
 * @param lines   source lines (without trailing newlines)
 * @param startNo 1-based line number of `lines[0]`
 */
export function numberLines(lines: string[], startNo = 1): string {
  if (lines.length === 0) return "";
  const lastNo = startNo + lines.length - 1;
  const width = String(lastNo).length;
  return lines
    .map((line, i) => `${String(startNo + i).padStart(width)}| ${line}`)
    .join("\n");
}

/**
 * Split source into display lines: handles all three line terminators
 * (`\r\n`, `\r`, `\n`) and strips ONE trailing terminator so a conventional
 * newline-terminated file does not yield a phantom empty last line. An empty
 * string yields `[]`.
 */
export function splitLines(content: string): string[] {
  if (content === "") return [];
  return content.replace(/\r\n$|\r$|\n$/, "").split(/\r\n|\r|\n/);
}

/**
 * Truncate to at most `maxCodepoints` code points, appending `…` if cut. Slices
 * on code-point (not UTF-16 code-unit) boundaries so an astral character / emoji
 * is never split into a lone, ill-formed surrogate.
 */
export function truncate(s: string, maxCodepoints: number): string {
  const cps = Array.from(s);
  if (cps.length <= maxCodepoints) return s;
  return `${cps.slice(0, maxCodepoints - 1).join("")}…`;
}
