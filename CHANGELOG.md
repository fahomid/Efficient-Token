# Changelog

All notable changes to **efficient-token** are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- The in-session health heartbeat now flushes immediately after each distilled read
  (coalesced to at most once per second), so `efficient-token status` and the status
  line reflect current savings between the 30s liveness ticks instead of lagging by
  up to 30s. The liveness timer is unchanged.

## [1.0.4] - 2026-06-19

A feature release: two new keyed-JSON tools, richer multi-target reads,
generated-file awareness, a diff-scoped test runner, opt-in incremental reads, and
a post-edit check on `apply_patch` — 47 tools total. All additive and backward
compatible.

### Added
- **`json_set` / `json_get` — surgical keyed-JSON editing.** `json_set` inserts or
  updates one top-level key of a JSON object in place: it replaces just that key's
  value span (every other byte preserved — no reserializing a 10k-line bundle) or
  appends it, and can set a sibling metadata key (default prefix `@`, the
  localization/ARB convention) in the same call. It re-validates the file as JSON
  before an atomic write, preserves a leading BOM and the file's line endings, and
  targets the effective member when a key is duplicated. `json_get` returns one
  key's value plus its sibling metadata in a single call. Generic over any large
  keyed JSON (localization bundles, token maps, config).
- **`read_many` multi-target reads.** A target may now name several `symbols` of one
  file, or a symbol `withCallees` to also pull the same-file functions it directly
  calls — collapsing outline → symbol → range round-trips into one call.
- **Generated-file awareness.** `code_search`, `repo_map`, and `diff_digest` hide
  machine-generated files by default — a built-in glob list (`*.min.js`, `*.g.dart`,
  `**/generated/**`, …) plus the `@generated` leading-comment marker — and report
  how many were hidden. `includeGenerated: true` shows them; extend the globs with
  `EFFICIENT_TOKEN_GENERATED_GLOBS`.
- **`test_run changed`.** Runs only the test files affected by the working-tree diff
  (changed tests plus tests referencing a changed source), and reports the
  selection so a pass never hides an un-run affected test.
- **`code_read elideIfUnchanged`.** Opt-in incremental reads: a repeat read of a
  target unchanged since earlier in the session returns a short "unchanged" marker
  instead of the bytes (re-orienting in edit loops). Always re-fetchable by reading
  again without the flag, and any content change returns the full source.
- **`apply_patch check`.** Optionally runs an allowlisted package.json script after a
  successful patch and appends its (failures-only) result, so the analyze step rides
  on the edit instead of a separate call. A failing check never hides that the patch
  applied.
- **Token-efficient tool preference + opt-in enforcement.** The server now advertises
  a preference for its drop-in tools over the host's built-ins, via the MCP
  `instructions` and a replacement clause on each drop-in tool's description (always
  on, influence-only). `efficient-token setup` / `uninstall` additionally install a
  **fail-open, heartbeat-gated** Claude Code `PreToolUse` hook that redirects
  read-only Bash drainers (`grep`/`rg`, `cat`/`head`/`tail`/`sed`, `find`/`ls`) to
  `code_search` / `code_read` / `glob` while the server is running — and never blocks
  anything when it is not (server down, hook error, or `EFFICIENT_TOKEN_ENFORCE=0`).
  The setup is opt-in, backs up and idempotently deep-merges
  `.claude/settings.local.json`, and uninstall removes exactly what it added.

- **In-session health, no API call.** The server publishes a detailed status JSON on
  its heartbeat. `efficient-token status` prints a full, health-style report —
  up/down, server version, tier, root, limits, and the session savings breakdown —
  with no model turn; `--line` gives a compact one-liner and `--json` the raw data.
  **`efficient-token setup` now installs a Claude Code `statusLine`** (alongside the
  enforcement hook) so this health shows in the session automatically — via a tiny
  generated `.claude/hooks/efficient-token-status.mjs`, never replacing a status line
  you set yourself. Use `--no-hook` for status-line-only, `--no-statusline` for
  hook-only; `uninstall` removes both. The `health` tool now also reports the version.

### Changed
- The deterministic file scanner now skips `.claude/` (tooling config, including the
  enforcement heartbeat and hooks), so it never appears in search or repo-map output.
- The published package no longer ships source maps (`*.js.map` / `*.d.ts.map`),
  roughly halving its size; `.d.ts` type declarations are still included.
- **`code_read` over-budget degrade now matches the built-in `Read`.** A whole-file
  read that exceeds the token budget returns the first page of real content with how
  to continue (`offset=…`, or `code_outline` for a symbol map), instead of leading
  with an outline. `read_at_rev` (which shares the render path) does the same.

### Fixed
- **`read_many` no longer reads the same target twice.** A symbol/range/file named
  in more than one target — or named explicitly and again pulled in as a callee —
  is now merged to a single read across the whole call, so its bytes aren't sent
  (or counted against the budget) twice; the header notes how many were merged.
- **Top-level CLI usage.** `efficient-token --help` / `--version` now print and
  exit; an unknown argument prints usage and exits non-zero instead of silently
  starting the stdio server.
- **Consistent cap / scan-truncation disclosure across tools.** Many tools applied a
  cap (head/top-N, the workspace-scan file limit, a token budget) or hit an empty
  result without saying so, so a partial or empty answer could look complete. They
  now disclose it the way `find_references`/`symbol_find` already did: `code_outline`
  bounds a very large outline; `call_hierarchy`/`call_sites`/`code_context`/
  `type_closure`/`marker_inventory`/`test_run` flag a truncated workspace scan;
  `design_tokens`/`token_usage` flag capped or truncated discovery (and `design_tokens`
  no longer drops JSON-array values); `trace_locate`/`check_locate`/`test_run` flag a
  capped error/frame list and disclose a location whose line no longer exists; and
  `review_branch`/`change_coverage`/`outline_diff` flag their diff caps and skipped
  files.
- **Native-parity fixes for the drop-in tools.** `code_search` multiline `content`
  mode now returns the spanned matching lines (it previously found nothing while
  `files`/`count` modes matched the same pattern); `code_read` reports end-of-file
  for an offset past the last line instead of re-returning the last line; and
  `glob`/`code_search`/`repo_map` honor a glob explicitly rooted at an otherwise-
  ignored directory (e.g. `dist/**`) instead of returning an empty result.

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

[1.0.4]: https://github.com/fahomid/Efficient-Token/releases/tag/v1.0.4
[1.0.3]: https://github.com/fahomid/Efficient-Token/releases/tag/v1.0.3
[1.0.2]: https://github.com/fahomid/Efficient-Token/releases/tag/v1.0.2
[1.0.1]: https://github.com/fahomid/Efficient-Token/releases/tag/v1.0.1
