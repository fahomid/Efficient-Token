import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { indentContinuation, topLevelObject, type JsonMember } from "../../core/json-locate.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { numberLines, splitLines } from "../../core/text.js";

/**
 * The write half of keyed-JSON work (json_query reads). Edits one top-level key
 * of a JSON object surgically: it locates that key's exact value span and splices
 * the replacement in place, so every other byte of a large file — a localization
 * bundle, a token map, a big config — is preserved and never re-serialized. A
 * sibling metadata key (default prefix "@", the localization/ARB convention) can
 * be set in the same call. The result is always re-parsed as JSON before writing,
 * so an edit can never leave the file invalid.
 */
export function jsonEditPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "json-edit",
    version: "1.0.5",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "json_get",
        title: "Get a JSON key",
        description:
          'Read one top-level key\'s value from a JSON object file, plus its sibling metadata key if present (e.g. "@key" for localization/ARB-style bundles). Returns just that entry, not the whole file. Use json_query for nested-path lookups or a top-level overview. JSON only. Read-only.',
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          path: z.string().describe("Path to a JSON file (relative to the workspace root)."),
          key: z.string().describe("Exact top-level key to read."),
          metaPrefix: z.string().optional().describe('Prefix of the sibling metadata key to include if present (default "@").'),
          maxTokens: z.number().int().positive().optional().describe("Output token budget."),
        },
        handler: async (args) => {
          try {
            const p = String(args.path);
            const key = String(args.key);
            const metaPrefix = args.metaPrefix === undefined ? "@" : String(args.metaPrefix);
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);

            const { content, abs } = await ctx.fs.read(p);
            const rel = ctx.paths.relative(abs);

            let data: unknown;
            try {
              data = JSON.parse(content);
            } catch (e) {
              return fail(`${rel} is not valid JSON: ${errMessage(e)}`);
            }
            if (data === null || typeof data !== "object" || Array.isArray(data)) {
              return fail(`${rel}: json_get needs a top-level JSON object. Use json_query for arrays/scalars.`);
            }
            const obj = data as Record<string, unknown>;
            if (!Object.prototype.hasOwnProperty.call(obj, key)) {
              const keys = Object.keys(obj).filter((k) => !k.startsWith(metaPrefix));
              return fail(`${rel}: no key "${key}". Available: ${keys.slice(0, 50).join(", ") || "(none)"}${keys.length > 50 ? ", …" : ""}.`);
            }

            const parts = [`${rel} ${JSON.stringify(key)} =\n${render(obj[key])}`];
            const metaKey = metaPrefix + key;
            if (Object.prototype.hasOwnProperty.call(obj, metaKey)) {
              parts.push(`${rel} ${JSON.stringify(metaKey)} =\n${render(obj[metaKey])}`);
            }
            return ok(clampText(parts.join("\n\n"), maxTokens));
          } catch (err) {
            return fail(`json_get failed: ${errMessage(err)}`);
          }
        },
      },
      {
        name: "json_set",
        title: "Set a JSON key",
        description:
          "Insert or update one top-level key in a JSON object file without rewriting the rest: it replaces just that key's value span in place (everything else stays byte-for-byte) or appends the key if absent. Optionally sets a sibling metadata key in the same call (default prefix \"@\"). Re-validates the whole file as JSON before writing; writes atomically. Use for large keyed JSON (localization bundles, token maps, config). For source code use code_edit.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          path: z.string().describe("Path to a JSON file (relative to the workspace root)."),
          key: z.string().describe("Exact top-level key to insert or update."),
          value: z.any().optional().describe("JSON value to set for the key (string, number, object, array, etc.). Omit to update only metadata."),
          metadata: z.any().optional().describe('JSON value for the sibling metadata key (e.g. {"description": "...", "placeholders": {...}}). Omit to leave metadata untouched.'),
          metaPrefix: z.string().optional().describe('Prefix for the sibling metadata key (default "@").'),
        },
        handler: async (args) => {
          try {
            const p = String(args.path);
            const key = String(args.key);
            const metaPrefix = args.metaPrefix === undefined ? "@" : String(args.metaPrefix);
            const hasValue = args.value !== undefined;
            const hasMetadata = args.metadata !== undefined;
            if (!hasValue && !hasMetadata) {
              return fail("json_set: provide a value and/or metadata to set.");
            }
            if (hasMetadata && metaPrefix === "") {
              return fail("json_set: metaPrefix must be non-empty to set a sibling metadata key.");
            }

            const { content, abs } = await ctx.fs.readRaw(p);
            const rel = ctx.paths.relative(abs);

            // A leading BOM is valid file content but not valid JSON input, so
            // validate against a BOM-stripped copy; the splice runs on the raw
            // content (topLevelObject reports BOM-aware offsets), preserving it.
            try {
              const root = JSON.parse(jsonBody(content));
              if (root === null || typeof root !== "object" || Array.isArray(root)) {
                return fail(`${rel}: json_set needs a top-level JSON object.`);
              }
            } catch (e) {
              return fail(`${rel} is not valid JSON: ${errMessage(e)}`);
            }

            const shaped = topLevelObject(content);
            if (!shaped.ok) return fail(`${rel}: ${shaped.reason}.`);
            const shape = shaped.shape;

            // One target per key being written, with its serialized member text.
            const targets: Array<{ k: string; valueText: string }> = [];
            if (hasValue) targets.push({ k: key, valueText: serializeValue(args.value, shape.indent) });
            if (hasMetadata) targets.push({ k: metaPrefix + key, valueText: serializeValue(args.metadata, shape.indent) });

            const splices: Array<{ start: number; end: number; text: string }> = [];
            const newMembers: string[] = [];
            const created: string[] = [];
            const updated: string[] = [];
            for (const t of targets) {
              // Target the LAST member with this key: duplicate top-level keys are
              // valid JSON and JSON.parse keeps the last, so editing the first
              // would be a silent no-op once the file is re-parsed.
              const existing = lastMember(shape.members, t.k);
              if (existing) {
                splices.push({ start: existing.valueStart, end: existing.valueEnd, text: t.valueText });
                updated.push(t.k);
              } else {
                newMembers.push(`${JSON.stringify(t.k)}: ${t.valueText}`);
                created.push(t.k);
              }
            }

            if (newMembers.length > 0) {
              if (shape.members.length > 0) {
                const last = shape.members[shape.members.length - 1]!;
                const text = newMembers.map((m) => `,\n${shape.indent}${m}`).join("");
                splices.push({ start: last.valueEnd, end: last.valueEnd, text });
              } else {
                const text = `\n${shape.indent}${newMembers.join(`,\n${shape.indent}`)}\n`;
                splices.push({ start: shape.contentStart, end: shape.contentEnd, text });
              }
            }

            // Match the file's newline style for any text we insert, so a CRLF
            // file doesn't gain stray LF lines. Only generated text is cast; the
            // original bytes are spliced through unchanged.
            if (content.includes("\r\n")) {
              for (const sp of splices) sp.text = sp.text.replace(/\n/g, "\r\n");
            }

            // Apply highest-offset first so earlier offsets stay valid.
            splices.sort((a, b) => b.start - a.start);
            let out = content;
            for (const sp of splices) out = out.slice(0, sp.start) + sp.text + out.slice(sp.end);

            // Safety net: never persist a file that would no longer parse.
            try {
              JSON.parse(jsonBody(out));
            } catch (e) {
              return fail(`json_set aborted (not written): the edit would produce invalid JSON (${errMessage(e)}). This is a bug — please report it.`);
            }

            await ctx.fs.writeAtomic(p, out);

            const firstChange = Math.min(...splices.map((s) => s.start));
            const summary = [
              created.length > 0 ? `created ${created.map((k) => JSON.stringify(k)).join(", ")}` : "",
              updated.length > 0 ? `updated ${updated.map((k) => JSON.stringify(k)).join(", ")}` : "",
            ]
              .filter(Boolean)
              .join("; ");
            return ok(`json_set ${rel}: ${summary}.\n${changedPreview(out, firstChange)}`);
          } catch (err) {
            return fail(`json_set failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

/** Strip a leading UTF-8 BOM so JSON.parse accepts otherwise-valid content. */
function jsonBody(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** The last member with this key — the one JSON.parse keeps for duplicate keys. */
function lastMember(members: JsonMember[], key: string): JsonMember | undefined {
  for (let i = members.length - 1; i >= 0; i--) {
    if (members[i]!.key === key) return members[i];
  }
  return undefined;
}

/** Serialize a JSON value for placement as a top-level member's value. */
function serializeValue(value: unknown, indent: string): string {
  const text = JSON.stringify(value, null, indent);
  // Undefined values never reach here (callers guard), but JSON.stringify can
  // still return undefined for e.g. a function; fall back to null defensively.
  if (text === undefined) return "null";
  return indentContinuation(text, indent);
}

/** Pretty-print a value for read output, faithfully. */
function render(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

/** Line-numbered window around the first change so the model can verify it. */
function changedPreview(content: string, at: number): string {
  const before = content.slice(0, at);
  let startLine = 1;
  for (let i = 0; i < before.length; i++) if (before.charCodeAt(i) === 10) startLine++;
  const lines = splitLines(content);
  if (lines.length === 0) return "(file is now empty)";
  const from = Math.max(1, startLine - 2);
  const to = Math.min(lines.length, startLine + 6);
  return numberLines(lines.slice(from - 1, to), from);
}

/** Truncate to ~maxTokens at a line boundary, never splitting a surrogate pair. */
function clampText(text: string, maxTokens: number): string {
  const budget = maxTokens * 4;
  if (text.length <= budget) return text;
  const cut = text.lastIndexOf("\n", budget);
  let end = cut > 0 ? cut : budget;
  const cu = text.charCodeAt(end - 1);
  if (cu >= 0xd800 && cu <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}\n… [truncated at ~${maxTokens} tokens]`;
}
