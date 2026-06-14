import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";

/**
 * `json_query` — read just a slice of a (possibly large) JSON file by a
 * dotted/bracket path (e.g. `scripts.build`, `items[0].name`), or — with no
 * query — a shallow overview of the top-level shape. Avoids pulling a whole big
 * config/lock/fixture into context for one value. Read-only. Free tier.
 */
export function jsonQueryPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "json-query",
    version: "0.1.0",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "json_query",
        title: "Query JSON",
        description:
          "Extract a value from a JSON file by a dotted/bracket path (e.g. \"scripts.build\", \"dependencies\", \"items[0].name\") instead of reading the whole file. With no query, returns a shallow overview of the top-level keys and their types/sizes. Output is token-bounded. JSON only. Read-only.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          path: z.string().describe("Path to a JSON file (relative to the workspace root)."),
          query: z.string().optional().describe('Dotted/bracket path, e.g. "scripts.build" or "a.b[0].c". Omit for a top-level overview.'),
          maxTokens: z.number().int().positive().optional().describe("Bound output size (default: server read budget)."),
        },
        handler: async (args) => {
          try {
            const p = String(args.path);
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);
            const { content, abs } = await ctx.fs.read(p);
            const rel = ctx.paths.relative(abs);

            let data: unknown;
            try {
              data = JSON.parse(content);
            } catch (e) {
              return fail(`${rel} is not valid JSON: ${errMessage(e)}`);
            }

            if (args.query === undefined || String(args.query).trim() === "") {
              return ok(clampText(`${rel} (top-level):\n${overview(data)}`, maxTokens));
            }

            const query = String(args.query);
            const segs = parseQuery(query);
            if (segs === null) return fail(`invalid query: ${JSON.stringify(query)}`);

            const traversed: string[] = [];
            let cur: unknown = data;
            for (const seg of segs) {
              if (cur === null || typeof cur !== "object") {
                return fail(`${rel}: cannot index into ${typeName(cur)} at "${traversed.join(".") || "(root)"}".`);
              }
              if (Array.isArray(cur)) {
                if (typeof seg !== "number" || seg < 0 || seg >= cur.length) {
                  return fail(`${rel}: index [${String(seg)}] out of range at "${traversed.join(".") || "(root)"}" (length ${cur.length}).`);
                }
                cur = cur[seg];
              } else {
                const key = String(seg);
                if (!Object.prototype.hasOwnProperty.call(cur, key)) {
                  const keys = Object.keys(cur as Record<string, unknown>);
                  return fail(`${rel}: no key "${key}" at "${traversed.join(".") || "(root)"}". Available: ${keys.slice(0, 50).join(", ") || "(none)"}.`);
                }
                cur = (cur as Record<string, unknown>)[key];
              }
              traversed.push(String(seg));
            }

            return ok(`${rel} ${query} =\n${render(cur, maxTokens)}`);
          } catch (err) {
            return fail(`json_query failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

/** Parse `a.b[0]["c"]` -> ["a","b",0,"c"]; null if malformed. */
function parseQuery(q: string): Array<string | number> | null {
  const out: Array<string | number> = [];
  let i = 0;
  if (q[i] === "$") i++;
  while (i < q.length) {
    const c = q[i];
    if (c === ".") {
      i++;
      continue;
    }
    if (c === "[") {
      const end = q.indexOf("]", i);
      if (end === -1) return null;
      const inner = q.slice(i + 1, end).trim();
      if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) {
        out.push(inner.slice(1, -1));
      } else if (/^\d+$/.test(inner)) {
        out.push(Number(inner));
      } else {
        out.push(inner);
      }
      i = end + 1;
    } else {
      let j = i;
      while (j < q.length && q[j] !== "." && q[j] !== "[") j++;
      out.push(q.slice(i, j));
      i = j;
    }
  }
  return out.length > 0 ? out : null;
}

const MAX_OVERVIEW_KEYS = 1000;

function overview(data: unknown): string {
  if (Array.isArray(data)) return `array (${data.length} item(s))`;
  if (data === null || typeof data !== "object") return `value: ${JSON.stringify(data)}`;
  const obj = data as Record<string, unknown>;
  const keys = Object.keys(obj);
  const lines = keys.slice(0, MAX_OVERVIEW_KEYS).map((k) => `  ${k}: ${describeVal(obj[k])}`);
  if (keys.length > MAX_OVERVIEW_KEYS) lines.push(`  … (+${keys.length - MAX_OVERVIEW_KEYS} more keys — query a path to drill in)`);
  return lines.join("\n");
}

function describeVal(v: unknown): string {
  if (Array.isArray(v)) return `array (${v.length})`;
  if (v === null) return "null";
  if (typeof v === "object") return `object (${Object.keys(v).length} keys)`;
  if (typeof v === "string") return v.length > 40 ? `string (${v.length} chars)` : `string: ${JSON.stringify(v)}`;
  return `${typeof v}: ${JSON.stringify(v)}`;
}

function render(value: unknown, maxTokens: number): string {
  const text = JSON.stringify(value, null, 2) ?? String(value);
  return clampText(text, maxTokens);
}

/** Truncate to ~maxTokens at a line boundary, never splitting a surrogate pair. */
function clampText(text: string, maxTokens: number): string {
  const budget = maxTokens * 4;
  if (text.length <= budget) return text;
  const cut = text.lastIndexOf("\n", budget);
  let end = cut > 0 ? cut : budget;
  const cu = text.charCodeAt(end - 1);
  if (cu >= 0xd800 && cu <= 0xdbff) end -= 1; // don't leave a lone high surrogate
  return `${text.slice(0, end)}\n… [truncated at ~${maxTokens} tokens — query a deeper path]`;
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
