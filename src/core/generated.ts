/**
 * Heuristics for machine-generated files, so search / mapping / diff tools can
 * hide them by default: they are noise the model rarely needs to read and are
 * often huge (a regenerated bundle can be a 10k-line diff). Detection is generic
 * across ecosystems — a curated glob list plus the industry-standard `@generated`
 * marker comment — and a project extends the globs via
 * `EFFICIENT_TOKEN_GENERATED_GLOBS`. Every tool that hides them also reports how
 * many were hidden and how to include them, so nothing is dropped silently.
 */

/**
 * Default globs marking generated files across common ecosystems. Each entry is
 * a generated-file *convention*, not a tie to any one framework; a project adds
 * its own (e.g. a localization output name) via the env var above.
 */
export const DEFAULT_GENERATED_GLOBS: readonly string[] = [
  // minified / bundled / source maps
  "*.min.js",
  "*.min.mjs",
  "*.min.css",
  "*.map",
  // protocol buffers / codegen across languages
  "*.pb.go",
  "*.pb.cc",
  "*.pb.h",
  "*.pb.swift",
  "*_pb2.py",
  "*_pb2.pyi",
  "*_pb.rb",
  // dart/flutter build_runner outputs (a generated-suffix convention)
  "*.g.dart",
  "*.freezed.dart",
  "*.gr.dart",
  // generic "generated" suffixes
  "*.generated.*",
  "*.gen.*",
  "*_generated.*",
  "*-generated.*",
  // conventional generated-output directories
  "**/generated/**",
  "**/__generated__/**",
];

/**
 * Whether a file's head carries the conventional `@generated` marker. Matches the
 * real convention (Phabricator/Prettier): the marker sits in the file's LEADING
 * comment block and the comment line begins with `@generated`. This deliberately
 * does NOT fire on a source file that merely mentions "@generated" in prose or a
 * mid-file comment — only on a genuine generated-file header — so hand-written
 * source is never hidden by accident.
 */
export function hasGeneratedMarker(headText: string): boolean {
  const lines = headText.split(/\r?\n/);
  for (let i = 0; i < lines.length && i < 40; i++) {
    const t = lines[i]!.trim();
    if (t === "") continue;
    if (i === 0 && t.startsWith("#!")) continue; // shebang, still pre-code
    const body = stripCommentPrefix(t);
    if (body === null) break; // first real code line — leading comment block ended
    if (body.startsWith("@generated")) return true;
  }
  return false;
}

/** Strip a leading line comment delimiter; null if the line isn't a comment. */
function stripCommentPrefix(line: string): string | null {
  const m = /^(\/\/+|\/\*+|\*+\/?|#+|--+|<!--|;+|%+|"""|''')\s*/.exec(line);
  return m ? line.slice(m[0].length) : null;
}
