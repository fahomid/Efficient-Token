# Changelog

All notable changes to **efficient-token** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Tool bundles (`EFFICIENT_TOKEN_GROUPS`): register only the tool groups a project
  uses, dropping the per-turn description cost of bundles it never needs. The
  bundles are `core` (always loaded) and `design`.
- In-session savings ledger, surfaced by `health`: an estimate of the tokens saved
  by distilled reads. The baseline is exact, comparing whole-file size against what
  was returned.
- `npm run toolcost`: a deterministic report of the fixed per-turn token cost of
  every tool definition, broken down by bundle.

### Changed
- Core read/edit/write/search/glob tools aligned to Claude Code's built-ins,
  matching the `file_path`/`offset`/`limit`/`old_string`/`new_string`/`pattern`
  shapes, so they are drop-in replacements that cut tokens in the middle.
- Trimmed filler from the costliest tool descriptions, lowering the fixed per-turn
  cost.

### Fixed
- The `core` bundle now always loads, so an additive `EFFICIENT_TOKEN_GROUPS`
  value such as `design`, or a typo, can never silently drop the core toolset.
- A delimiter-only `EFFICIENT_TOKEN_GROUPS` value such as `","` is treated as unset
  (load all) instead of registering zero tools.
- `read_many` no longer counts a shared file's savings baseline once per target.
  It opted out of per-target accounting, so it under-counts rather than overstates.
- Neutral wording for the startup "skipped" log, which was mislabeled "not
  entitled" for bundle skips.
- `move_symbol` import-back into the source now keeps the `.js` extension when the
  project uses it (inferred from the source, destination, and any importer being
  rewritten), so it resolves under NodeNext. It also reports the moved code's
  same-file dependencies (any case, not just capitalized) so the destination's
  imports can be completed.
- `color_contrast` recognizes the full set of CSS named colors (e.g.
  `rebeccapurple`), not just a small subset.
- `repo_map` emits each directory header once, even when a subdirectory name sorts
  between that directory's own files.

## [0.1.0] - 2026-06-14

Initial release. A local-first [MCP](https://modelcontextprotocol.io) server that
returns distilled, faithful results to cut LLM token usage without degrading
reasoning.

### Added
- **Kernel**: plugin contract, tier-gating loader (the only SDK-touching code),
  path sandbox, atomic size-guarded filesystem, tree-sitter AST service (WASM,
  ~53 extensions → 33 grammars), deterministic scanner, token budgeter, and an
  inert free-only entitlement stub (the premium seam).
- **Read & navigate**: `code_outline`, `code_read`, `read_many`, `read_at_rev`,
  `glob`, `json_query`, `repo_map`.
- **Search & symbols**: `code_search`, `grep_context`, `find_references`,
  `symbol_find`, `call_sites`, `call_hierarchy`, `marker_inventory`, `import_map`,
  `type_closure`, `code_context`.
- **Git & review**: `diff_digest`, `review_branch`, `commit_log`, `line_blame`,
  `symbol_history`, `outline_diff`, `conflict_digest`, `change_coverage`.
- **Creative / design**: `view_image`, `media_info`, `design_tokens`,
  `color_contrast`, `svg_digest`, `font_info`, `token_usage`.
- **Run & locate**: `code_check`, `check_locate`, `trace_locate`, `test_run`.
- **Edit (atomic, syntax-guarded)**: `code_edit`, `code_write`, `replace_symbol`,
  `apply_patch`, `move_symbol`, `project_rename`.
- **Session**: `note_write` / `note_read`, plus `health`.
- Smoke self-test (`npm run smoke`) and a real-stdio end-to-end test (`npm run e2e`).

[Unreleased]: https://github.com/fahomid/Efficient-Token/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/fahomid/Efficient-Token/releases/tag/v0.1.0
