# Changelog

All notable changes to **efficient-token** are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.3] - 2026-06-18

A robustness release: best-effort steps (pre-write syntax validation, process
cleanup, output trimming) can no longer fail a tool or crash the server, and
degrade faithfully instead.

### Fixed
- **Edits no longer fail on a parser trap.** `code_edit` and `apply_patch` run a
  best-effort syntax check before writing. On some inputs the tree-sitter (WASM)
  parser traps with "memory access out of bounds"; freeing the parser afterwards
  then threw the same trap, which escaped the caught path and failed the edit.
  Parser construction and cleanup are now isolated, so a trap degrades to skipped
  validation — the edit still applies.
- **A timed-out script can no longer crash the server (Windows).** Killing a
  timed-out process tree spawned `taskkill` with no error listener; if that spawn
  failed asynchronously (binary not found, or resource pressure), the stray error
  became uncaught and tore down the server and its connection. The kill is now
  fully best-effort: the worst case is a leaked child, not a crash.
- **A failing script always shows its error.** When a failing script's output was
  a single line longer than the token budget, `code_check` / `check_locate` /
  `test_run` returned an empty report; they now return a faithful tail of that
  line.

### Changed
- The server installs last-resort handlers so an unexpected stray error is logged
  to stderr and the server keeps serving, rather than dropping the stdio
  connection.

## [1.0.2] - 2026-06-15

A bug-fix release: edits now tolerate CRLF/LF newline differences, with a
standalone health probe and a clearer savings report.

### Fixed
- **Edits across CRLF/LF line endings.** `code_edit` and `apply_patch` matched
  anchors byte-for-byte, so a multi-line `old_string` written with LF newlines
  never matched a file saved with CRLF — single-line anchors were unaffected,
  which masked it until a multi-line edit hit a CRLF file. Matching now tries an
  exact match first (nothing outside the matched span ever changes) and, on a
  miss, re-casts a multi-line anchor and its replacement to the file's own newline
  style, the way Claude's `Edit` does. The file keeps its existing line endings
  everywhere else.

### Added
- **`npm run health`** — a protocol-level health probe that spawns the built
  server over real MCP stdio, calls `health`, and prints the report, with no model
  involved; it exits non-zero if the server fails to start or report ok. The
  README documents it alongside `claude mcp list` and the MCP Inspector.

### Changed
- **Clearer savings report.** `health` now shows three explicit numbers — the
  tokens this server returned, what the equivalent whole-file reads would have
  cost, and the net saved with a percentage — instead of one dense line.

### Internal
- CI now runs green on Node 24. The smoke sweep compiles the tree-sitter WASM
  grammars with low-memory V8 flags to avoid a Node 24 out-of-memory during
  grammar compilation.
- Slimmer npm tarball: publish only `dist`, `README.md`, `CHANGELOG.md`, and
  `LICENSE`. `ARCHITECTURE.md` is a repo-only design doc and is no longer shipped.

## [1.0.1] - 2026-06-15

First public release. A local-first [MCP](https://modelcontextprotocol.io) server
that returns distilled, faithful results to cut LLM token usage without degrading
reasoning. 45 tools span code navigation, search, git review, creative/design
work, running checks, and editing.

### Highlights
- **Faithful by design.** Anything the model reasons over is returned losslessly
  (real slices, real symbols). Savings come from returning less, never from
  summarizing.
- **Drop-in for Claude Code's built-ins.** `code_read`, `code_edit`, `code_write`,
  `code_search`, and `glob` mirror the input and output of Read, Edit, Write,
  Grep, and Glob, so they swap in with no re-learning and cut tokens in the middle.
- **Measurable.** `health` reports the tokens saved this session (exact baseline:
  whole-file size against what was returned); `npm run toolcost` reports the fixed
  per-turn cost of the tool definitions.
- **Local-first and sandboxed.** All file access is confined to the workspace root
  (symlink- and ADS-safe), writes are atomic, edits are syntax-guarded, and the
  runner tools only execute allowlisted `package.json` scripts.

### Tools (45)
- **Read & navigate:** `health`, `code_outline`, `code_read`, `read_many`,
  `read_at_rev`, `glob`, `json_query`, `repo_map`.
- **Search & symbols:** `code_search`, `grep_context`, `find_references`,
  `symbol_find`, `call_sites`, `call_hierarchy`, `marker_inventory`, `import_map`,
  `type_closure`, `code_context`.
- **Git & review:** `diff_digest`, `review_branch`, `commit_log`, `line_blame`,
  `symbol_history`, `outline_diff`, `conflict_digest`, `change_coverage`.
- **Creative & design:** `view_image`, `media_info`, `design_tokens`,
  `color_contrast`, `svg_digest`, `font_info`, `token_usage`.
- **Run & locate:** `code_check`, `check_locate`, `trace_locate`, `test_run`.
- **Edit & session (atomic, syntax-guarded):** `code_edit`, `code_write`,
  `replace_symbol`, `apply_patch`, `move_symbol`, `project_rename`,
  `note_write` / `note_read`.

### Core
- Kernel plus a tier- and bundle-gated plugin loader (the only code that touches
  the SDK), a path sandbox, an atomic size-guarded filesystem, a tree-sitter AST
  service (WASM; ~53 file extensions across 33 grammars), a deterministic scanner,
  a token budgeter, and an in-session savings ledger.
- **Tool bundles** (`EFFICIENT_TOKEN_GROUPS`): register only the groups you use to
  shed the per-turn description cost of the rest. `core` always loads; `design` is
  optional.
- **Open-core seam:** an optional runtime hook loads premium plugins from a
  separate, privately-licensed package when installed, gated by the entitlement
  check. The package exports the plugin contract types so a premium package can
  build against it. No premium code or entitlement implementation is included.
- Strict TypeScript and ESM (NodeNext). Self-tests via `npm run smoke` and a
  real-stdio `npm run e2e`; CI runs on Ubuntu and Windows across Node 18, 20, 22,
  and 24.

[1.0.3]: https://github.com/fahomid/Efficient-Token/releases/tag/v1.0.3
[1.0.2]: https://github.com/fahomid/Efficient-Token/releases/tag/v1.0.2
[1.0.1]: https://github.com/fahomid/Efficient-Token/releases/tag/v1.0.1
