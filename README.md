<div align="center">

# efficient-token

**A local-first [MCP](https://modelcontextprotocol.io) server that cuts LLM token usage — without degrading reasoning.**

It does deterministic code work on your machine and returns only distilled, *faithful* results to the model: real slices, real symbols, a fraction of the tokens.

[![CI](https://github.com/fahomid/Efficient-Token/actions/workflows/ci.yml/badge.svg)](https://github.com/fahomid/Efficient-Token/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/efficient-token.svg)](https://www.npmjs.com/package/efficient-token)
[![Node](https://img.shields.io/node/v/efficient-token.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-db61a2?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/fahomid)

[Install](#install) · [Verify](#verify-it-works) · [Make Claude use it](#make-claude-prefer-these-tools) · [Tools](#tools) · [Measure savings](#measuring-token-savings)

</div>

---

## The idea

> **One principle:** anything the model will *reason over* (source code, document
> text) is returned **losslessly** — real slices, real symbols. Savings come from
> returning **less** (one symbol instead of a whole file), never from summarizing.
> The server detects and transforms deterministically; it never makes a judgment
> the model should make.

Concretely — to see one function in a 200-line file:

|              | Built-in `Read`         | efficient-token `code_read`                |
| ------------ | ----------------------- | ------------------------------------------ |
| **Call**     | `Read(file)`            | `code_read(file, symbol)`                  |
| **Returns**  | the whole 200-line file | just that function's real source           |
| **Tokens**   | ~2,400                  | ~400                                       |
| **Fidelity** | full                    | **identical** — real source, not a summary |

Same reasoning material, a fraction of the context. Multiply that across a session
and the savings compound.

## Contents

- [What you get](#what-you-get)
- [Requirements](#requirements)
- [Install](#install)
- [Verify it works](#verify-it-works)
- [Make Claude prefer these tools](#make-claude-prefer-these-tools)
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

| | |
| --- | --- |
| **47 tools** | Reading, searching, git review, editing, and creative/design work — each returns the *real* content the model needs, just less of it. |
| **Drop-in built-ins** | `code_read`, `code_edit`, `code_write`, `code_search`, and `glob` mirror Read / Edit / Write / Grep / Glob (same inputs, same output shape) — the model swaps them in with no re-learning. |
| **Measurable** | `health` shows tokens saved this session; `npm run toolcost` shows the fixed per-turn cost of the tool definitions. |
| **Safe by construction** | Every path is confined to the workspace root (symlink- and ADS-safe), writes are atomic, edits are syntax-guarded, and the runner tools only execute scripts already in your `package.json`. |
| **Broad language support** | tree-sitter via WASM — no native build step. |

## Requirements

- **Node.js ≥ 18** — ESM and WASM tree-sitter; no native build step.
- **An MCP host.** Examples below use **Claude Code**, but any stdio MCP host works.

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

<details>
<summary>Prefer a global install</summary>

```bash
npm i -g efficient-token
claude mcp add efficient-token -s user -- efficient-token
```

</details>

<details>
<summary>From source (for development)</summary>

```bash
git clone https://github.com/fahomid/Efficient-Token.git
cd Efficient-Token
npm install
npm run build        # tsc -> dist/index.js
claude mcp add efficient-token -- node "$(pwd)/dist/index.js"
```

Skip the build and run the TypeScript directly during development:

```bash
claude mcp add efficient-token -- npx tsx "$(pwd)/src/index.ts"
```

</details>

<details>
<summary>Other MCP hosts</summary>

It's a standard stdio MCP server. Point any host at the command
`npx -y efficient-token` (or `node /abs/path/dist/index.js`) over stdio.

</details>

### Set it up (recommended)

Registering the server is enough to *use* the tools. Two quick steps make Claude
**prefer** them and let you **see the savings** in-session:

**1 — Tell Claude to prefer the tools.** Add a short routing rule to your `CLAUDE.md`
(`~/.claude/CLAUDE.md` for every project, or a project's `./CLAUDE.md`). The exact
block to paste is in [Make Claude prefer these tools](#make-claude-prefer-these-tools).

**2 — Install enforcement + the in-session status line.** From your project root:

```bash
npx efficient-token setup          # redirect hook + health status line (opt-in, fail-open)

# variants:
npx efficient-token setup --no-hook        # status line only (no enforcement)
npx efficient-token setup --no-statusline  # enforcement hook only
npx efficient-token setup --scope user     # apply to every project (~/.claude)
npx efficient-token uninstall              # revert exactly what setup added

# from a source checkout instead of npx:
npm run setup                              # (or: node dist/index.js setup)
```

This redirects a stray `Bash` `grep`/`cat`/`find` to the MCP tools (fail-open — it
never blocks when the server is down) and shows live token savings in your status
bar with **no API call**. See [enforcement](#token-efficient-enforcement-opt-in)
and the [status line](#health-in-the-status-line-no-api-call) for how each works.

> Both are opt-in and fully reversible — nothing is written until you run `setup`,
> and `uninstall` removes exactly what it added. **Restart the session** afterward so
> Claude Code picks up the status line.

## Verify it works

MCP servers load when the host session starts, so **start (or restart) a session**
after registering. To confirm it's connected:

- Run `/mcp` in Claude Code — `efficient-token` should show as connected.
- Or, **without involving the model**, run `claude mcp list` (shows each server and
  whether it connects), or probe the `health` tool directly over the protocol:

  ```bash
  npm run health        # spawns dist/index.js, calls health, prints the report
  # or, interactively, the official inspector:
  npx @modelcontextprotocol/inspector node dist/index.js
  ```

`health` reports the version, workspace root, limits, and the tokens saved so far:

```text
efficient-token: ok
version: 1.0.5
tier: free
root: /abs/path/to/your/project
maxReadTokens: 6000
maxFileBytes: 2000000
savings this session (estimate):
  efficient-token read ~0 tokens of source and passed ~0 to Claude — ~0% fewer (0 read(s))
  saved ~0 tokens
```

> The savings ledger is per server process, so `npm run health` (a fresh process)
> always reads zero — it's a liveness/config check. To see a **live** session's
> savings *without the model*, run `efficient-token status` (it reads the running
> server's heartbeat) or wire up the
> [status line](#health-in-the-status-line-no-api-call); or ask the model to call
> `health` in that session.

## Make Claude prefer these tools

Registering the server already nudges the model toward these tools — it advertises
the preference in its MCP `instructions` and in every drop-in tool's description.
For a stronger, always-applied steer, add a short routing rule to your
[`CLAUDE.md`](https://docs.anthropic.com/en/docs/claude-code/memory). Put it in
`~/.claude/CLAUDE.md` to apply everywhere, or a project's `./CLAUDE.md` for that
repo only:

````md
## Tool preference: efficient-token

An `efficient-token` MCP server is available. Its tools return the same real
source and data as reading or grepping files, distilled to far fewer tokens.
**Default to them over the built-in file tools and over reading whole files or raw
git output**, whenever one fits the task — the tool list has the exact names and
when to use each. As a rule of thumb:

- **Drop-in replacements — always prefer over the built-in:** `code_read` over
  `Read`, `code_search` over `Grep`, `glob` over `Glob`, `code_edit` over `Edit`,
  `code_write` over `Write`.
- **Understand code without reading whole files:** `code_outline`, `repo_map`,
  `code_context`, `find_references`, `symbol_find`, `call_hierarchy`, `call_sites`,
  `import_map`, `type_closure`, `grep_context`, `marker_inventory`, `read_many`
  (now reads several symbols at once and a symbol with its callees), `json_query`,
  `json_get` (a key plus its sibling metadata).
- **Review changes and history:** `diff_digest`, `review_branch`, `outline_diff`,
  `commit_log`, `line_blame`, `symbol_history`, `read_at_rev`, `conflict_digest`,
  `change_coverage` — instead of reading changed files or parsing raw `git`.
- **Run checks and chase failures:** `code_check`, `test_run`, `check_locate`,
  `trace_locate` (run allowlisted package.json scripts; failures-only output).
- **Edit precisely:** `apply_patch` for multi-file edits (optionally running a
  package.json check after), `json_set` to insert/update a key in a large JSON
  bundle without rewriting it, `replace_symbol` to rewrite a whole definition,
  `move_symbol`, `project_rename`; `note_write` / `note_read` to persist findings
  across steps.
- **Inspect images, design, and media:** `view_image`, `media_info`,
  `color_contrast`, `design_tokens`, `font_info`, `svg_digest`, `token_usage`.

Fall back to the built-in tools only for what efficient-token doesn't cover —
PDFs, notebooks, and other non-code files.
````

Don't feel obliged to copy the whole list: the opening paragraph plus the first
bullet (the built-in overrides) is enough on its own — the model discovers the
rest from the tool descriptions, which load every turn regardless.

### Token-efficient enforcement (opt-in)

The soft steer above is usually enough. For **hard, automatic enforcement** — so a
stray `Bash` `grep` / `cat` / `find` is actively redirected to the MCP tool — the
server ships an opt-in setup that installs a Claude Code [`PreToolUse`
hook](https://docs.anthropic.com/en/docs/claude-code/hooks). It is **fail-open**:
if the server isn't running, isn't installed, or anything errors, your built-in
tools work exactly as normal — nothing is ever blocked.

```bash
# run from your project root — installs BOTH the redirect hook and the status line
npx efficient-token setup       # or: node /abs/path/to/dist/index.js setup
npx efficient-token uninstall   # removes exactly what setup added
# --scope user      target ~/.claude/settings.json instead of the project
# --no-hook         install only the status line   ·   --no-statusline   only the hook
```

`setup` writes `.claude/settings.local.json` (git-ignored by default), a redirect
hook at `.claude/hooks/efficient-token-redirect.mjs`, and a status-line script at
`.claude/hooks/efficient-token-status.mjs`. It sets the `statusLine` only when you
don't already have one — it never clobbers yours.

**How it works.** While the server runs it touches `.claude/.efficient-token.alive`
every 30 seconds. The hook checks that heartbeat on every `Bash` call: **only when
it is fresh** does it deny a *bare, read-only* drainer — a command whose first word
is `grep`/`rg`, `cat`/`head`/`tail`/`sed`, or `find`/`ls`, with no pipe, chain,
redirect, or write flag — and tell the model to use `code_search` / `code_read` /
`glob` instead. Everything else is allowed: a pipeline or chain (so `npm test |
grep`, `git log | head` run untouched), a mutation (`sed -i`, `find -delete`,
`cat > f`), a stale/missing heartbeat, unparseable input, or any command without an
MCP equivalent. `flutter test`, `git …`, and package managers are never blocked.

- **Opt-in & reversible.** Nothing is written until you run `setup`; it backs up the
  settings file, deep-merges idempotently (re-running updates in place, never
  duplicates), and `uninstall` removes exactly the managed hook.
- **Disable the heartbeat** entirely with `EFFICIENT_TOKEN_ENFORCE=0` — the hook
  then always fails open.

### Health in the status line (no API call)

`efficient-token setup` (above) **already wires this up** — it points Claude Code's
[`statusLine`](https://docs.anthropic.com/en/docs/claude-code/statusline) at a tiny
generated script that reads the server's heartbeat and shows health in the session
with **no model turn / no API call**, refreshed automatically. Want *only* the
status line (no enforcement)? Run `efficient-token setup --no-hook`. It never
replaces a status line you set yourself.

The widget renders e.g. `efficient-token v1.0.5 (free): up · 3.1k token read and
passed 210 token to Claude (~93% less)`, or `efficient-token: not running` when the
server is down.

Prefer to wire it by hand instead? Point `statusLine` at the built-in command:

```json
// .claude/settings.json
{
  "statusLine": { "type": "command", "command": "node /abs/path/to/dist/index.js status --line" }
}
```

Run `npx efficient-token status` yourself for the **full, health-style report** —
version, tier, root, limits, and the session savings breakdown — all from the
heartbeat, no API call:

```text
efficient-token: up
version: 1.0.5
tier: free
root: /abs/project
maxReadTokens: 6000
maxFileBytes: 2000000
savings this session (estimate):
  efficient-token read ~3100 tokens of source and passed ~210 to Claude — ~93% fewer (12 read(s))
  saved ~2890 tokens
last heartbeat: 4s ago
```

(Both figures are real measurements — the source it read vs. what it passed to
Claude. The server can't see the model's true session total; only Claude Code's
`/cost` can.)

(`--json` gives the raw data.) It reads the same heartbeat as the enforcement hook,
so `EFFICIENT_TOKEN_ENFORCE=0` makes it report "not running". The `health` tool
reports the same details — including the server version — when you want them
in-conversation instead.

## Usage

You don't call these tools by hand — the **model** picks them while it works. A few
things worth knowing:

- **Workspace root.** All file access is confined to one root (`EFFICIENT_TOKEN_ROOT`,
  default: the directory the host launched in). Paths are relative to that root.
- **Reads degrade, never dump.** A whole-file read over the token budget returns the
  first page of real content (like the built-in `Read`) with how to continue
  (`offset=…`, or `code_outline` for a map) — so a huge file can't blow your context.
- **Edits are guarded.** `code_edit` / `code_write` / `apply_patch` / `replace_symbol`
  refuse a change that would leave an unclosed token (set `validate=false` to
  override) and write atomically. The mutating tools declare `destructiveHint`, so
  your host can confirm them.
- **Trim what you don't use.** If you only do code work, set
  `EFFICIENT_TOKEN_GROUPS=core` to drop the design/media tools and save their
  per-turn description cost (see [Configuration](#configuration)).

## Measuring token savings

Two complementary numbers, both built in.

**1 · Tokens saved this session — `health`, `status`, or the status line.** Every
distilled read records two real numbers: the source it read (what a whole-file
`Read` would have returned) and what it actually passed to Claude. `health`,
`efficient-token status`, and the status line all surface the running total:

```text
savings this session (estimate):
  efficient-token read ~2455 tokens of source and passed ~406 to Claude — ~83% fewer (2 read(s))
  saved ~2049 tokens [read 1671t/1, outline 379t/1]
```

Both figures are real byte counts (the token figure is an estimate at ~4
chars/token, clamped so it can never overstate). Ask the model to call `health`
in-conversation, or — with no API call — run `efficient-token status` or watch the
[status line](#health-in-the-status-line-no-api-call).

**2 · Fixed per-turn cost — `npm run toolcost`.** Every tool definition (name +
description + schema) ships to the model on **every** turn, whether or not it fires.
This reports that fixed cost, broken down by bundle and by top offenders:

```bash
npm run toolcost
# TOTAL  47 tool(s)  31299 chars  ~7825 tok
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
| `EFFICIENT_TOKEN_MAX_READ_TOKENS` | `6000` | Whole-file read budget before `code_read` returns a first-page preview. |
| `EFFICIENT_TOKEN_MAX_FILE_BYTES` | `2000000` | Hard cap on the size of any file the server will read. |
| `EFFICIENT_TOKEN_GROUPS` | *(all)* | Comma-separated tool **bundles** to register: `core` (everything except the design tools) and `design` (`color_contrast`, `font_info`, `design_tokens`, `svg_digest`, `token_usage`, `media_info`). Unset loads all; `core` always loads. Example: `core` in a code-only repo, `core,design` for UI/video work. |
| `EFFICIENT_TOKEN_GENERATED_GLOBS` | *(none)* | Extra comma-separated globs marking generated files to hide by default from `code_search` / `repo_map` / `diff_digest` (added to the built-in defaults like `*.min.js`, `*.g.dart`, `**/generated/**`). Override per call with `includeGenerated: true`. |

## Tools

47 tools, grouped by what you reach for. Every tool is read-only unless marked
*(mutating)* or *(executes)*. All are free and MIT-licensed.

| Group | Tools | What for |
| --- | --- | --- |
| **Read & navigate** | 10 | read symbols/ranges, outline, repo map, keyed JSON |
| **Search & symbols** | 10 | grep, references, call graph, types |
| **Git & review** | 8 | diffs, blame, history, coverage |
| **Creative & design** | 7 | images, media, color, fonts, SVG |
| **Run & locate** | 4 | run checks/tests, jump to failures |
| **Edit & session** | 8 | atomic edits, rename, move, notes |

<details open>
<summary><strong>Read &amp; navigate</strong> · 10 tools</summary>

| Tool | Use it to… |
| --- | --- |
| `health` | Confirm the server is connected and see tier, workspace, and limits, plus the estimated tokens saved this session by distilled reads. The baseline is exact: whole-file size against what was returned. *(read-only)* |
| `code_outline` | List a file's symbols (functions, classes, methods, types) with line ranges and signatures, without the source. *(read-only)* |
| `code_read` | Like Claude's `Read` (same `file_path`/`offset`/`limit`, cat-n output) but leaner: it can also extract one symbol, and a whole-file read over budget returns the first page of content (with how to continue) rather than dumping the file. *(read-only)* |
| `glob` | List file paths matching a glob or type, with no content, like Claude's `Glob` (same `pattern`/`path`). Find files without reading directories. Sorted by name for reproducibility rather than by mtime. *(read-only)* |
| `read_many` | Read several symbols, ranges, or files in one call, the read-side analog of `apply_patch`. One target can name several `symbols` of one file, or a symbol `withCallees` (the same-file functions it calls), collapsing outline → symbol → range round-trips. Output is labeled and budget-bounded. *(read-only)* |
| `code_read` *(elide)* | `code_read` also takes `elideIfUnchanged`: a repeat read of a target unchanged since earlier this session returns a short "unchanged" marker instead of the bytes (re-orienting in edit loops). Re-read without the flag to get the source. *(read-only)* |
| `json_query` | Extract a value from a JSON file by a dotted or bracket path (`scripts.build`, `items[0].name`) instead of reading the whole file. With no query it returns a shallow top-level overview of keys with their types and sizes. Token-bounded. *(read-only)* |
| `json_get` | Read one top-level key's value from a JSON object file, plus its sibling metadata key if present (e.g. `@key` for localization/ARB-style bundles), in one call. *(read-only)* |
| `json_set` | Insert or update one top-level key in a JSON object file *surgically* — it replaces just that key's value span in place (everything else stays byte-for-byte) or appends the key, and can set a sibling metadata key too. Re-validates as JSON before an atomic write. For large keyed JSON (localization bundles, token maps, config). *(mutating)* |
| `read_at_rev` | The historical `code_read`: read one symbol, line range, or whole file as of a git revision, degrading to an outline over budget, instead of letting `git show <ref>:file` dump everything. *(read-only)* |
| `repo_map` | A token-bounded table of contents: the file tree grouped by directory, with each source file's top-level symbols (classes, functions, types). Orient in a codebase without reading files. Generated files are hidden by default (count reported); `includeGenerated: true` to show them. *(read-only)* |

</details>

<details>
<summary><strong>Search &amp; symbols</strong> · 10 tools</summary>

| Tool | Use it to… |
| --- | --- |
| `code_search` | Like Claude's `Grep` (ripgrep), with the same params: `output_mode` (`files_with_matches`/`content`/`count`), `glob`/`type`, `-A`/`-B`/`-C`, `-i`, `-n`, `-o`, `head_limit`, `multiline`. Returns matches, not whole files. Generated files (glob list + `@generated` marker) are skipped by default (count reported); `includeGenerated: true` to include. *(read-only)* |
| `grep_context` | Regex search that returns each match with its enclosing function or class source (deduped, line-numbered, matched lines marked `›`). One call replaces a search followed by opening each file. *(read-only)* |
| `find_references` | Locate where a symbol is defined (AST-precise: kind, line, signature) and where it is used (identifier-boundary scan) across the workspace, as `file:line` locations. *(read-only)* |
| `symbol_find` | Find where symbols are defined by name, exact or `substring` for fuzzy recall, returning `file:line` with kind and signature. Takes an optional `kind` filter. *(read-only)* |
| `call_sites` | Where a symbol is actually called (the AST callee of a call), not text matches. Excludes imports, type uses, comments, and value-passing. Each hit gives `file:line`, the enclosing symbol, and the call line. TS/JS, Python, Go, Rust, Java, C/C++, Ruby. *(read-only)* |
| `call_hierarchy` | A function's local call neighborhood in one call: its callees (functions it calls, each with where it's defined) and its callers (workspace call sites). For callers alone, `call_sites` is lighter. *(read-only)* |
| `marker_inventory` | Inventory code-comment markers (TODO/FIXME/HACK/XXX/BUG, or custom `tags`) across the workspace, grouped by tag, each as `file:line + text`. Matches only after a comment leader so prose isn't a false positive. *(read-only)* |
| `import_map` | A file's dependency edges: what it imports (workspace files vs external packages) and who imports it, resolved across the workspace instead of grepping import lines. JS/TS family. *(read-only)* |
| `type_closure` | A type's definition plus the verbatim defs of the workspace types it transitively references (cycle-safe, depth-bounded). Understand a complex type in one call instead of chasing each referenced type. *(read-only)* |
| `code_context` | A task primer for a symbol in one shot: its definition source, the workspace symbols it uses (with signatures), and where it is referenced. Primes a task without chasing dependencies. *(read-only)* |

</details>

<details>
<summary><strong>Git &amp; review</strong> · 8 tools</summary>

| Tool | Use it to… |
| --- | --- |
| `diff_digest` | Review git changes as hunks only, or as a `--stat` summary or file list, scoped by `ref`/`staged`/`path`, instead of reading whole changed files. Generated files are excluded by default (count reported); `includeGenerated: true` to include. Read-only git. *(read-only)* |
| `review_branch` | A semantic change summary: each changed file with the symbols that changed (functions, classes), mapped from the diff to the AST. Review a branch or PR without reading hunks. *(read-only)* |
| `commit_log` | Compact commit history, one row per commit (`sha date author subject`, no bodies or diffs), scoped by `path`/`ref`/`limit` instead of raw `git log`. *(read-only)* |
| `line_blame` | Line provenance via `git blame`, with contiguous same-commit runs collapsed into ranges (`Lstart-Lend sha date author summary`). Scope it to a symbol or range; uncommitted lines are marked. *(read-only)* |
| `symbol_history` | The history of one symbol or line range via `git log -L`, as `list` or `hunks`, instead of `git log` plus per-commit `git show` dragging in whole files. *(read-only)* |
| `outline_diff` | A symbol-level delta between two revisions: per changed file, the symbols added, removed, or changed. An API-surface diff that skips the hunks; works on arbitrary rev-to-rev. *(read-only)* |
| `conflict_digest` | Show only the three-way regions of merge-conflicted files (ours, base, theirs, verbatim and line-numbered) instead of reading whole files to find `<<<<<<<` markers. Extracts only; you decide the resolution. *(read-only)* |
| `change_coverage` | Intersect your changed lines with an lcov coverage artifact to answer "did I test my change?". Lists covered against uncovered changed lines with the enclosing symbol. *(read-only)* |

</details>

<details>
<summary><strong>Creative &amp; design</strong> · 7 tools</summary>

| Tool | Use it to… |
| --- | --- |
| `view_image` | See raster image files (png/jpg/gif/webp/avif/bmp) directly: pass paths, get them back as viewable images. Inspect a rendered frame, screenshot, or exported asset instead of guessing. Oversized files are refused. *(read-only)* |
| `media_info` | Distilled facts about image, video, and audio files: format, dimensions, aspect ratio, byte size, plus duration/fps/codec for A/V when `ffprobe` is present. Reads metadata without loading the bytes. *(read-only)* |
| `design_tokens` | Distill a project's design tokens (colors, sizes/spacing, typography) as verbatim `name=value` pairs from CSS custom properties and design-token JSON, grouped by kind, instead of re-reading whole stylesheets. *(read-only)* |
| `color_contrast` | Deterministic color math: the WCAG contrast ratio with AA/AAA pass/fail between two colors, or convert one color between hex, rgb, and hsl. Accepts hex (3/4/6/8), rgb(), hsl(), and CSS color names. *(read-only)* |
| `svg_digest` | An SVG's structure: `viewBox`, intrinsic size, an element-type histogram, and defined ids, without dumping the verbose markup and path data. *(read-only)* |
| `font_info` | The real family and style of fonts rather than a guess from filenames. Reads family/subfamily from TTF/OTF `name` tables, and `@font-face` declarations from CSS. *(read-only)* |
| `token_usage` | Audit CSS custom properties: which are defined but never referenced via `var()`, and which are used but never defined, each with a `file:line`. *(read-only)* |

</details>

<details>
<summary><strong>Run &amp; locate</strong> · 4 tools</summary>

| Tool | Use it to… |
| --- | --- |
| `code_check` | Run one of the project's own `package.json` scripts (test, build, lint, typecheck) and return a one-line PASS or bounded failure output, never the whole log. Allowlisted to defined scripts, so no arbitrary commands. *(executes)* |
| `check_locate` | Like `code_check`, but on failure it parses `file:line` from the output and returns the failing source with its enclosing symbol — the check failed, so here's the code, in one call. *(executes)* |
| `trace_locate` | Paste a stack trace or error output and get the source at each `file:line` frame, with context and the enclosing symbol. External and `node_modules` frames are skipped. *(read-only)* |
| `test_run` | Run a focused test by forwarding a `filter` to a package.json test script (`npm run test -- <filter>`), or set `changed: true` to run only the tests affected by the working-tree diff (changed tests + tests referencing a changed source). Returns PASS or a bounded failure tail with the failing source; the selection is reported. The filter is charset-restricted to exclude shell metacharacters. *(executes)* |

</details>

<details>
<summary><strong>Edit &amp; session</strong> · 8 tools · <em>atomic, syntax-guarded</em></summary>

| Tool | Use it to… |
| --- | --- |
| `code_edit` | Like Claude's `Edit` (same `file_path`/`old_string`/`new_string`/`replace_all`): the match must be verbatim and unique unless `replace_all=true`, missing or ambiguous matches are refused, and the write is atomic. Tolerates CRLF/LF newline differences. Refuses a change leaving an unclosed token unless `validate=false`. *(mutating)* |
| `code_write` | Like Claude's `Write` (same `file_path`/`content`); creates parent dirs and writes atomically. Carries the same syntax-error guard as `code_edit`. *(mutating)* |
| `replace_symbol` | Replace a whole function/class/method definition by name: pass only the new source, not the old body as a match anchor. Resolves the span via the AST (export/decorator-aware, line-ending and BOM faithful), disambiguates by `container`/`occurrence`, syntax-guarded, atomic. *(mutating)* |
| `apply_patch` | Apply many edits across one or more files in one atomic, all-or-nothing call. Each edit is `{ file_path, old_string, new_string, replace_all? }`. Validated (incl. syntax guard) in memory first; if anything fails, nothing is written. Optionally runs a package.json `check` after applying and appends its result. *(mutating)* |
| `move_symbol` | Relocate a definition from one file to another atomically, rewriting the named imports/re-exports of it across the workspace and importing it back into the source if still used. Reports the moved code's dependencies so you can complete the destination's imports. `dryRun`-able, syntax-guarded. JS/TS. *(mutating)* |
| `project_rename` | Rename an identifier across the whole workspace in one atomic call (identifier-boundary, syntax-guarded, `dryRun`-able) instead of find_references plus editing each file. Textual, scoped with `path`/`type`. *(mutating)* |
| `note_write` / `note_read` | A small persistent scratchpad under `.efficient-token/notes/`. Stash and recall plans and findings across steps and agents. *(write / read)* |

</details>

## Language support

`code_read` and `code_outline` use [tree-sitter](https://tree-sitter.github.io/)
(via WASM); the language is chosen by file extension.

<details open>
<summary><strong>Full symbol outlines</strong> — functions, classes, methods, types extracted accurately</summary>

> TypeScript (`.ts .mts .cts`), TSX (`.tsx`), JavaScript (`.js .mjs .cjs .jsx`),
> Python (`.py`), Ruby (`.rb`), PHP (`.php`), Go (`.go`), Rust (`.rs`),
> Zig (`.zig`), C (`.c .h`), C++ (`.cpp .cc .cxx .hpp .hh .hxx`), C# (`.cs`),
> Objective-C (`.m`), Java (`.java`), Kotlin (`.kt .kts`), Scala (`.scala .sc`),
> Swift (`.swift`), Dart (`.dart`), OCaml (`.ml .mli`), ReScript (`.res .resi`),
> Emacs Lisp (`.el`), Lua (`.lua`), Bash (`.sh .bash .zsh`), Solidity (`.sol`),
> SystemRDL (`.rdl`), TLA⁺ (`.tla`)

</details>

<details>
<summary><strong>Parse-only</strong> — these parse (so <code>code_read</code> works) but produce few or no outline symbols by design</summary>

> HTML (`.html .htm`), CSS (`.css`), Vue (`.vue`), ERB/EJS (`.erb .ejs`),
> JSON (`.json`), TOML (`.toml`), Elixir (`.ex .exs`)

</details>

Any other file type still works with `code_read` in range or whole-file mode; only
the symbol-aware features need a grammar.

## Architecture

A small **kernel** that knows nothing about any feature, plus **plugins** that
receive a shared `CoreContext` and depend only on it, never on each other.

```text
src/
  core/      contract.ts · config.ts · loader.ts · premium.ts · result.ts
             read.ts · text.ts · edits.ts · git.ts · run-script.ts
  services/  logger.ts · paths.ts · fs.ts · ast.ts · scan.ts
             budget.ts · savings.ts · license.ts
  plugins/   one folder per tool (47 tools across the groups above)
  index.ts   bootstrap: build ctx, register plugins, serve over stdio
scripts/
  smoke.ts   in-process self-test      e2e.ts      real-stdio round-trip
  toolcost.ts per-turn cost report     discover.ts grammar node inspector
```

- **stdout is the MCP protocol stream.** The server never writes to it; all logs go
  to stderr.
- **All filesystem access is sandboxed** to the workspace root, and writes are atomic.
- **Only the loader touches the SDK** and gates tools by tier and bundle.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full design, conventions, and the
plugin contract.

## Open-core / premium

This package is **MIT and free**, forever. It's also wired for **open-core**: future
premium plugins ship in a separate, privately-licensed package and are loaded only
when installed and entitled — the core never depends on them, and the free tools are
unaffected. The package exports the plugin contract types so a premium package can
build against it. **No premium code is part of this release.** See
[`ARCHITECTURE.md`](./ARCHITECTURE.md#premium-plugins-open-core) for the contract.

## Development

```bash
npm run typecheck   # tsc --noEmit (src + scripts)
npm run build       # emit dist/
npm test            # smoke + e2e (must print ALL PASS)
npm run dev         # run the server from source via tsx
npm run health      # protocol-level health probe (no model)
npm run toolcost    # per-turn token cost of the tool definitions
```

**Adding a plugin:** create `src/plugins/<name>/index.ts` exporting a factory that
returns a `Plugin`, talk only to `ctx`, set the correct `tier`, add one entry to the
`plugins` array in `src/index.ts`, and extend `scripts/smoke.ts`. Nothing else
changes. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the full workflow.

## Contributing & security

- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — dev setup, the plugin contract, the
  Definition of Done, and the release process.
- [`SECURITY.md`](./SECURITY.md) — the sandbox/security model and how to report a
  vulnerability privately.
- [`CHANGELOG.md`](./CHANGELOG.md) — release history.

## License

[MIT](./LICENSE) — free for personal and commercial use.

<div align="center">
<sub>If efficient-token saves you tokens and you'd like to support its development,
sponsorship is welcome and entirely optional —
<a href="https://github.com/sponsors/fahomid">github.com/sponsors/fahomid</a>.</sub>
</div>
