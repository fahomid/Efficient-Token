import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";

const NOTES_DIR = ".efficient-token/notes";
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const notePath = (name: string): string => `${NOTES_DIR}/${name}.md`;

/**
 * A small persistent scratchpad (`note_write` / `note_read`) under
 * `.efficient-token/notes/`, so multi-step or multi-agent work can stash and
 * recall plans and findings without re-deriving them or re-reading the codebase.
 * Confined to a fixed safe path.
 */
export function notePlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "note",
    version: "1.0.2",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "note_write",
        title: "Write a note",
        description:
          "Save (or append to) a named note under .efficient-token/notes/, a scratchpad for plans, findings, or TODOs that persists across steps and agents. Use it to avoid re-deriving context. name is a slug ([A-Za-z0-9._-]); set append=true to add to an existing note.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        inputSchema: {
          name: z.string().min(1).describe("Note name (slug, e.g. \"plan\")."),
          content: z.string().describe("Note content to write."),
          append: z.boolean().optional().describe("Append to the existing note instead of overwriting."),
        },
        handler: async (args) => {
          try {
            const name = String(args.name);
            if (!SAFE_NAME.test(name)) {
              return fail(`invalid note name: ${JSON.stringify(name)} (allowed: letters, digits, . _ -; must start alphanumeric).`);
            }
            const content = String(args.content);
            const rel = notePath(name);
            let toWrite = content;
            let appended = false;
            if (args.append === true && (await ctx.fs.exists(rel))) {
              const prev = (await ctx.fs.read(rel)).content;
              toWrite = prev.endsWith("\n") || prev === "" ? prev + content : `${prev}\n${content}`;
              appended = true;
            }
            await ctx.fs.writeAtomic(rel, toWrite);
            const bytes = Buffer.byteLength(toWrite, "utf8");
            return ok(`${appended ? "Appended to" : "Wrote"} note "${name}" (${bytes} bytes) at ${rel}.`);
          } catch (err) {
            return fail(`note_write failed: ${errMessage(err)}`);
          }
        },
      },
      {
        name: "note_read",
        title: "Read a note",
        description:
          "Read a named note saved by note_write, or with no name list all saved notes (under .efficient-token/notes/). Use it to recall plans and findings from earlier steps.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          name: z.string().optional().describe("Note name to read. Omit to list all notes."),
        },
        handler: async (args) => {
          try {
            if (args.name === undefined) {
              const scan = await ctx.scan.files({ within: NOTES_DIR, exts: ["md"] });
              if (scan.files.length === 0) return ok("No notes saved yet.");
              const list = scan.files
                .map((f) => `  ${f.rel.slice(NOTES_DIR.length + 1).replace(/\.md$/, "")}`)
                .sort()
                .join("\n");
              return ok(`Notes (${scan.files.length}):\n${list}`);
            }
            const name = String(args.name);
            if (!SAFE_NAME.test(name)) {
              return fail(`invalid note name: ${JSON.stringify(name)}.`);
            }
            const rel = notePath(name);
            if (!(await ctx.fs.exists(rel))) {
              return fail(`no note named "${name}". Use note_read with no name to list notes.`);
            }
            const { content } = await ctx.fs.read(rel);
            return ok(`note "${name}":\n${content}`);
          } catch (err) {
            return fail(`note_read failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}
