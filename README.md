# efficient-token

[![CI](https://github.com/fahomid/Efficient-Token/actions/workflows/ci.yml/badge.svg)](https://github.com/fahomid/Efficient-Token/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/efficient-token.svg)](https://www.npmjs.com/package/efficient-token)
[![Node](https://img.shields.io/node/v/efficient-token.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A **local-first [MCP](https://modelcontextprotocol.io) server** that does
deterministic code work on your machine and returns only distilled, **faithful**
results to the model — cutting token usage **without degrading reasoning**.

> **The one principle:** anything the model will *reason over* (source code,
> document text) is returned **losslessly** — real slices, real symbols. Savings
> come from returning **less** (one symbol instead of a whole file), never from
> summarizing. The server detects and transforms deterministically; it never makes
> a judgment the model should make.

A concrete example: instead of `Read`-ing a 200-line file to see one function, the
model calls `code_read` with a symbol name and gets back just that function's real
source — the same content it would have reasoned over, a fraction of the tokens.

## Contents

- [What you get](#what-you-get)
- [Requirements](#requirements)
- [Install](#install)
- [Verify it works](#verify-it-works)
- [Usage](#usage)
- [Measuring token savings](#measuring-token-savings)
- [Configuration](#configuration)
- [Tools](#tools)
- [Language support](#language-support)
- [Architecture](#architecture)
- [Open-core / premium](#open-core--premium)
- [Development](#development)
- [Contributing & security](#contributing--security)
- [License](#license)

## What you get

- **45 tools** for reading, searching, reviewing git, editing, and creative/design
  work — each returns the *real* content the model needs, just less of it.
- **Drop-in replacements for Claude Code's built-ins.** `code_read`, `code_edit`,
  `code_write`, `code_search`, and `glob` mirror Read / Edit / Write / Grep / Glob
  (same inputs, same output shape), so the model uses them with no re-learning and
  saves tokens in the middle.
- **Measurable savings.** `health` shows the tokens saved this session;
  `npm run toolcost` shows the fixed per-turn cost of the tool definitions.
- **Safe by construction.** Every path is confined to the workspace root
  (symlink- and ADS-safe), writes are atomic, edits are syntax-guarded, and the
  runner tools only execute scripts already defined in your `package.json`.
- **Broad language support** via tree-sitter (WASM, no native build step).

## Requirements

- **Node.js ≥ 18** (uses ESM and WASM tree-sitter; no native build step).
- An MCP host. Examples below use **Claude Code**, but any stdio MCP host works.

## Install

### With Claude Code (recommended)

Register the published package with `npx` — no clone, no build:

```bash
# available in every project (user scope)
claude mcp add efficient-token -s user -- npx -y efficient-token
```

Drop `-s user` to register it for the current project only. To pin the workspace
the server may touch, add `--env EFFICIENT_TOKEN_ROOT=/abs/path/to/project`
(otherwise it uses the directory you launched the host in).

Prefer a global install? It works too:

```bash
npm i -g efficient-token
claude mcp add efficient-token -s user -- efficient-token
```

### From source

```bash
git clone https://github.com/fahomid/Efficient-Token.git
cd efficient-token
npm install
npm run build        # tsc -> dist/index.js
claude mcp add efficient-token -- node "$(pwd)/dist/index.js"
```

During development you can skip the build and run the TypeScript directly:

```bash
claude mcp add efficient-token -- npx tsx "$(pwd)/src/index.ts"
```

### Other MCP hosts

It's a standard stdio MCP server. Point any host at the command
`npx -y efficient-token` (or `node /abs/path/dist/index.js`) over stdio.

## Verify it works

MCP servers load when the host session starts, so **start (or restart) a session**
after registering. Then:

- Run `/mcp` in Claude Code — `efficient-token` should show as connected.
- Or ask the model to call the **`health`** tool. It reports the workspace root,
  the limits, and the tokens saved so far:

```
efficient-token: ok
tier: free
root: /abs/path/to/your/project
maxReadTokens: 6000
maxFileBytes: 2000000
savings (this session, estimate): ~0 tokens over 0 distilled read(s)
```

## Usage

You don't call these tools by hand — the **model** picks them while it works. Once
the server is registered, Claude will reach for `code_read`/`code_outline` instead
of dumping whole files, `code_search` instead of `Grep`, `diff_digest` to review
changes, and so on. A few notes:

- **Workspace root.** All file access is confined to one root (`EFFICIENT_TOKEN_ROOT`,
  default: the directory the host launched in). Paths are relative to that root.
- **Reads degrade, never dump.** A whole-file read over the token budget returns an
  outline plus a bounded head, with an instruction to request a specific symbol or
  range — so a huge file can't blow your context.
- **Edits are guarded.** `code_edit` / `code_write` / `apply_patch` / `replace_symbol`
  refuse a change that would leave an unclosed token (set `validate=false` to
  override), and write atomically. The mutating tools declare `destructiveHint`, so
  you can have your host confirm them.
- **Trim what you don't use.** If you only do code work, set
  `EFFICIENT_TOKEN_GROUPS=core` to drop the design/media tools and save their
  per-turn description cost (see below).

## Measuring token savings

Two complementary numbers, both built in:

**1. Tokens saved this session — the `health` tool.** Every distilled read records
an exact baseline (what a whole-file `Read` would have returned) against what was
actually returned, and `health` surfaces the running total:

```
savings (this session, estimate): ~2049 tokens over 2 distilled read(s)
  (returned ~406 vs ~2455 whole-file) [read 1671t/1, outline 379t/1]
```

The baseline is exact (real byte counts); the token figure is an estimate at ~4
chars/token, clamped so it can never overstate. Just ask the model to call
`health` at any point to see the tally.

**2. Fixed per-turn cost — `npm run toolcost`.** Every tool definition (name +
description + schema) ships to the model on **every** turn, whether or not it
fires. This reports that fixed cost, broken down by bundle and by top offenders:

```bash
npm run toolcost
# TOTAL  45 tool(s)  28236 chars  ~7059 tok
```

Use it to decide which **bundles** to load. Setting `EFFICIENT_TOKEN_GROUPS=core`
drops the design tools and saves roughly 760 tokens per turn in a pure-code repo;
run `toolcost` before and after to see the exact difference.

## Configuration

All configuration is via environment variables (pass them with `--env` when you
register the server).

| Variable | Default | Meaning |
| --- | --- | --- |
| `EFFICIENT_TOKEN_ROOT` | current working dir | Workspace root. All file access is confined here. |
| `EFFICIENT_TOKEN_MAX_READ_TOKENS` | `6000` | Whole-file read budget before `code_read` degrades to an outline. |
| `EFFICIENT_TOKEN_MAX_FILE_BYTES` | `2000000` | Hard cap on the size of any file the server will read. |
| `EFFICIENT_TOKEN_GROUPS` | *(all)* | Comma-separated tool **bundles** to register. The bundles are `core` (everything except the design tools) and `design` (`color_contrast`, `font_info`, `design_tokens`, `svg_digest`, `token_usage`, `media_info`). Unset loads all; `core` always loads. Example: `core` in a code-only repo, `core,design` for UI/video work. |

## Tools

45 tools, grouped by what you reach for. Every tool is read-only unless marked
*(mutating)* or *(executes)*. All are free and MIT-licensed.

### Read & navigate

| Tool | Use it to… |
| --- | --- |
| `health` | Confirm the server is connected and see tier, workspace, and limits, plus the estimated tokens saved this session by distilled reads. The baseline is exact: whole-file size against what was returned. *(read-only)* |
| `code_outline` | List a file's symbols (functions, classes, methods, types) with line ranges and signatures, without the source. *(read-only)* |
| `code_read` | Like Claude's `Read` (same `file_path`/`offset`/`limit`, cat-n output) but leaner: it can also extract one symbol, and a whole-file read over budget degrades to an outline plus head rather than dumping the file. *(read-only)* |
| `glob` | List file paths matching a glob or type, with no content, like Claude's `Glob` (same `pattern`/`path`). Find files without reading directories. Sorted by name for reproducibility rather than by mtime. *(read-only)* |
| `read_many` | Read several symbols, ranges, or files in one call, the read-side analog of `apply_patch`. Output is labeled and budget-bounded, which cuts per-call round-trips. *(read-only)* |
| `json_query` | Extract a value from a JSON file by a dotted or bracket path (`scripts.build`, `items[0].name`) instead of reading the whole file. With no query it returns a shallow top-level overview of keys with their types and sizes. Token-bounded. *(read-only)* |
| `read_at_rev` | The historical `code_read`: read one symbol, line range, or whole file as of a git revision, degrading to an outline over budget, instead of letting `git show <ref>:file` dump everything. *(read-only)* |
| `repo_map` | A token-bounded table of contents: the file tree grouped by directory, with each source file's top-level symbols (classes, functions, types). Orient in a codebase without reading files. *(read-only)* |

### Search & symbols

| Tool | Use it to… |
| --- | --- |
| `code_search` | Like Claude's `Grep` (ripgrep), with the same params: `output_mode` (`files_with_matches`/`content`/`count`), `glob`/`type`, `-A`/`-B`/`-C`, `-i`, `-n`, `-o`, `head_limit`, `multiline`. Returns matches, not whole files. *(read-only)* |
| `grep_context` | Regex search that returns each match with its enclosing function or class source (deduped, line-numbered, matched lines marked `›`). One call replaces a search followed by opening each file. *(read-only)* |
| `find_references` | Locate where a symbol is defined (AST-precise: kind, line, signature) and where it is used (identifier-boundary scan) across the workspace, as `file:line` locations. *(read-only)* |
| `symbol_find` | Find where symbols are defined by name, exact or `substring` for fuzzy recall, returning `file:line` with kind and signature. Takes an optional `kind` filter. *(read-only)* |
| `call_sites` | Where a symbol is actually called (the AST callee of a call), not text matches. Excludes imports, type uses, comments, and value-passing. Each hit gives `file:line`, the enclosing symbol, and the call line. TS/JS, Python, Go, Rust, Java, C/C++, Ruby. *(read-only)* |
| `call_hierarchy` | A function's local call neighborhood in one call: its callees (functions it calls, each with where it's defined) and its callers (workspace call sites). For callers alone, `call_sites` is lighter. *(read-only)* |
| `marker_inventory` | Inventory code-comment markers (TODO/FIXME/HACK/XXX/BUG, or custom `tags`) across the workspace, grouped by tag, each as `file:line + text`. Matches only after a comment leader so prose isn't a false positive. *(read-only)* |
| `import_map` | A file's dependency edges: what it imports (workspace files vs external packages) and who imports it, resolved across the workspace instead of grepping import lines. JS/TS family. *(read-only)* |
| `type_closure` | A type's definition plus the verbatim defs of the workspace types it transitively references (cycle-safe, depth-bounded). Understand a complex type in one call instead of chasing each referenced type. *(read-only)* |
| `code_context` | A task primer for a symbol in one shot: its definition source, the workspace symbols it uses (with signatures), and where it is referenced. Primes a task without chasing dependencies. *(read-only)* |

### Git & review

| Tool | Use it to… |
| --- | --- |
| `diff_digest` | Review git changes as hunks only, or as a `--stat` summary or file list, scoped by `ref`/`staged`/`path`, instead of reading whole changed files. Read-only git. *(read-only)* |
| `review_branch` | A semantic change summary: each changed file with the symbols that changed (functions, classes), mapped from the diff to the AST. Review a branch or PR without reading hunks. *(read-only)* |
| `commit_log` | Compact commit history, one row per commit (`sha date author subject`, no bodies or diffs), scoped by `path`/`ref`/`limit` instead of raw `git log`. *(read-only)* |
| `line_blame` | Line provenance via `git blame`, with contiguous same-commit runs collapsed into ranges (`Lstart-Lend sha date author summary`). Scope it to a symbol or range; uncommitted lines are marked. *(read-only)* |
| `symbol_history` | The history of one symbol or line range via `git log -L`, as `list` or `hunks`, instead of `git log` plus per-commit `git show` dragging in whole files. *(read-only)* |
| `outline_diff` | A symbol-level delta between two revisions: per changed file, the symbols added, removed, or changed. An API-surface diff that skips the hunks; works on arbitrary rev-to-rev. *(read-only)* |
| `conflict_digest` | Show only the three-way regions of merge-conflicted files (ours, base, theirs, verbatim and line-numbered) instead of reading whole files to find `<<<<<<<` markers. Extracts only; you decide the resolution. *(read-only)* |
| `change_coverage` | Intersect your changed lines with an lcov coverage artifact to answer "did I test my change?". Lists covered against uncovered changed lines with the enclosing symbol. *(read-only)* |

### Creative & design

| Tool | Use it to… |
| --- | --- |
| `view_image` | See raster image files (png/jpg/gif/webp/avif/bmp) directly: pass paths, get them back as viewable images. Inspect a rendered frame, screenshot, or exported asset instead of guessing. Oversized files are refused. *(read-only)* |
| `media_info` | Distilled facts about image, video, and audio files: format, dimensions, aspect ratio, byte size, plus duration/fps/codec for A/V when `ffprobe` is present. Reads metadata without loading the bytes. *(read-only)* |
| `design_tokens` | Distill a project's design tokens (colors, sizes/spacing, typography) as verbatim `name=value` pairs from CSS custom properties and design-token JSON, grouped by kind, instead of re-reading whole stylesheets. *(read-only)* |
| `color_contrast` | Deterministic color math: the WCAG contrast ratio with AA/AAA pass/fail between two colors, or convert one color between hex, rgb, and hsl. Accepts hex (3/4/6/8), rgb(), hsl(), and CSS color names. *(read-only)* |
| `svg_digest` | An SVG's structure: `viewBox`, intrinsic size, an element-type histogram, and defined ids, without dumping the verbose markup and path data. *(read-only)* |
| `font_info` | The real family and style of fonts rather than a guess from filenames. Reads family/subfamily from TTF/OTF `name` tables, and `@font-face` declarations from CSS. *(read-only)* |
| `token_usage` | Audit CSS custom properties: which are defined but never referenced via `var()`, and which are used but never defined, each with a `file:line`. *(read-only)* |

### Run & locate

| Tool | Use it to… |
| --- | --- |
| `code_check` | Run one of the project's own `package.json` scripts (test, build, lint, typecheck) and return a one-line PASS or bounded failure output, never the whole log. Allowlisted to defined scripts, so no arbitrary commands. *(executes)* |
| `check_locate` | Like `code_check`, but on failure it parses `file:line` from the output and returns the failing source with its enclosing symbol — the check failed, so here's the code, in one call. *(executes)* |
| `trace_locate` | Paste a stack trace or error output and get the source at each `file:line` frame, with context and the enclosing symbol. External and `node_modules` frames are skipped. *(read-only)* |
| `test_run` | Run a focused test by forwarding a `filter` to a package.json test script (`npm run test -- <filter>`), returning PASS or a bounded failure tail with the failing source. The filter is charset-restricted to exclude shell metacharacters. *(executes)* |

### Edit & session *(atomic, syntax-guarded)*

| Tool | Use it to… |
| --- | --- |
| `code_edit` | Like Claude's `Edit` (same `file_path`/`old_string`/`new_string`/`replace_all`): the match must be verbatim and unique unless `replace_all=true`, missing or ambiguous matches are refused, and the write is atomic. Refuses a change leaving an unclosed token unless `validate=false`. *(mutating)* |
| `code_write` | Like Claude's `Write` (same `file_path`/`content`); creates parent dirs and writes atomically. Carries the same syntax-error guard as `code_edit`. *(mutating)* |
| `replace_symbol` | Replace a whole function/class/method definition by name: pass only the new source, not the old body as a match anchor. Resolves the span via the AST (export/decorator-aware, line-ending and BOM faithful), disambiguates by `container`/`occurrence`, syntax-guarded, atomic. Avoids re-sending the existing body. *(mutating)* |
| `apply_patch` | Apply many edits across one or more files in one atomic, all-or-nothing call. Each edit is `{ file_path, old_string, new_string, replace_all? }`. Validated (incl. syntax guard) in memory first; if anything fails, nothing is written. *(mutating)* |
| `move_symbol` | Relocate a definition from one file to another atomically, rewriting the named imports/re-exports of it across the workspace and importing it back into the source if still used. Reports the moved code's dependencies so you can complete the destination's imports. `dryRun`-able, syntax-guarded. JS/TS. *(mutating)* |
| `project_rename` | Rename an identifier across the whole workspace in one atomic call (identifier-boundary, syntax-guarded, `dryRun`-able) instead of find_references plus editing each file. Textual, scoped with `path`/`type`. *(mutating)* |
| `note_write` / `note_read` | A small persistent scratchpad under `.efficient-token/notes/`. Stash and recall plans and findings across steps and agents. *(write / read)* |

## Language support

`code_read` and `code_outline` use [tree-sitter](https://tree-sitter.github.io/)
(via WASM); the language is chosen by file extension.

**Full symbol outlines** — functions, classes, methods, types, and the like are
extracted accurately:

> TypeScript (`.ts .mts .cts`), TSX (`.tsx`), JavaScript (`.js .mjs .cjs .jsx`),
> Python (`.py`), Ruby (`.rb`), PHP (`.php`), Go (`.go`), Rust (`.rs`),
> Zig (`.zig`), C (`.c .h`), C++ (`.cpp .cc .cxx .hpp .hh .hxx`), C# (`.cs`),
> Objective-C (`.m`), Java (`.java`), Kotlin (`.kt .kts`), Scala (`.scala .sc`),
> Swift (`.swift`), Dart (`.dart`), OCaml (`.ml .mli`), ReScript (`.res .resi`),
> Emacs Lisp (`.el`), Lua (`.lua`), Bash (`.sh .bash .zsh`), Solidity (`.sol`),
> SystemRDL (`.rdl`), TLA⁺ (`.tla`)

**Parse-only** — these parse (so `code_read` works everywhere) but produce few or
no outline symbols by design (markup, config, data, or macro-based definitions):

> HTML (`.html .htm`), CSS (`.css`), Vue (`.vue`), ERB/EJS (`.erb .ejs`),
> JSON (`.json`), TOML (`.toml`), Elixir (`.ex .exs`)

Any other file type still works with `code_read` in range or whole-file mode; only
the symbol-aware features need a grammar.

## Architecture

A small **kernel** that knows nothing about any feature, plus **plugins** that
receive a shared `CoreContext` and depend only on it, never on each other.

```
src/
  core/      contract.ts · config.ts · loader.ts · premium.ts · result.ts
             read.ts · text.ts · edits.ts · git.ts · run-script.ts
  services/  logger.ts · paths.ts · fs.ts · ast.ts · scan.ts
             budget.ts · savings.ts · license.ts
  plugins/   one folder per tool (45 tools across the groups above)
  index.ts   bootstrap: build ctx, register plugins, serve over stdio
scripts/
  smoke.ts   in-process self-test      e2e.ts      real-stdio round-trip
  toolcost.ts per-turn cost report     discover.ts grammar node inspector
```

- **stdout is the MCP protocol stream.** The server never writes to it; all logs go
  to stderr.
- **All filesystem access is sandboxed** to the workspace root, and writes are
  atomic.
- **Only the loader touches the SDK** and gates tools by tier and bundle.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full design, conventions, and
the plugin contract.

## Open-core / premium

This package is **MIT and free**, forever. It's also wired for **open-core**:
future premium plugins ship in a separate, privately-licensed package and are
loaded only when installed and entitled — the core never depends on them, and the
free tools are unaffected. The package exports the plugin contract types so a
premium package can build against it. No premium code is part of this release. See
[`ARCHITECTURE.md`](./ARCHITECTURE.md#premium-plugins-open-core) for the contract.

## Development

```bash
npm run typecheck   # tsc --noEmit (src + scripts)
npm run build       # emit dist/
npm test            # smoke + e2e (must print ALL PASS)
npm run dev         # run the server from source via tsx
npm run toolcost    # report the per-turn token cost of the tool definitions
```

Adding a plugin: create `src/plugins/<name>/index.ts` exporting a factory that
returns a `Plugin`, talk only to `ctx`, set the correct `tier`, add one entry to
the `plugins` array in `src/index.ts`, and extend `scripts/smoke.ts`. Nothing else
changes. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the full workflow.

## Contributing & security

- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — dev setup, the plugin contract, and the
  Definition of Done.
- [`SECURITY.md`](./SECURITY.md) — the sandbox/security model and how to report a
  vulnerability privately.
- [`CHANGELOG.md`](./CHANGELOG.md) — release history.

## License

[MIT](./LICENSE). Free for personal and commercial use.
