import { z } from "zod";

import type { CoreContext, Plugin, ToolContent } from "../../core/contract.js";
import { errMessage, fail } from "../../core/result.js";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // per-image default
const MAX_PER_IMAGE_BYTES = 8 * 1024 * 1024; // hard ceiling even if caller asks for more
const MAX_TOTAL_BYTES = 12 * 1024 * 1024; // aggregate cap across all images in one call
const MAX_PATHS = 8;

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
};

/**
 * Returns one or more image files to you as viewable images, instead of
 * describing them or waiting for a human to paste a screenshot. Use it to view a
 * rendered frame, an exported asset, a screenshot, or a generated preview after
 * you produce it (e.g. run your project's render/screenshot script with
 * code_check, then view the output).
 */
export function viewImagePlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "view-image",
    version: "1.0.2",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "view_image",
        title: "View image",
        description:
          "See raster image file(s) directly (png/jpg/gif/webp/avif/bmp): pass one or more paths and they are returned to you as viewable images. Use this to inspect a rendered frame, screenshot, or exported asset after generating it, instead of guessing or asking for a paste. Render at a modest size; oversized files are refused (raise maxBytes). For SVG/vector use code_read or svg_digest. Read-only.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          paths: z.array(z.string()).min(1).max(MAX_PATHS).describe("Image file path(s) relative to the workspace root (e.g. a rendered frame)."),
          maxBytes: z.number().int().positive().max(MAX_PER_IMAGE_BYTES).optional().describe(`Per-image size limit before it is refused (default ${DEFAULT_MAX_BYTES}, max ${MAX_PER_IMAGE_BYTES}).`),
        },
        handler: async (args) => {
          try {
            // Bound all three multiplicands (count × per-image × aggregate) so the
            // emitted base64 stays token/transport-bounded regardless of input.
            const paths = (args.paths as unknown[]).map(String).slice(0, MAX_PATHS);
            const maxBytes = Math.min(args.maxBytes === undefined ? DEFAULT_MAX_BYTES : Number(args.maxBytes), MAX_PER_IMAGE_BYTES);

            const notes: string[] = [];
            const blocks: ToolContent[] = [];
            let total = 0;
            for (const p of paths) {
              const ext = extOf(p);
              const mime = MIME_BY_EXT[ext];
              if (mime === undefined) {
                notes.push(`  ${p}: skipped (not a supported raster image${ext === "svg" ? "; use code_read/svg_digest for SVG" : ""})`);
                continue;
              }
              try {
                const { abs, bytes } = await ctx.fs.readBytes(p, maxBytes);
                const rel = ctx.paths.relative(abs);
                if (total + bytes.length > MAX_TOTAL_BYTES) {
                  notes.push(`  ${rel}: skipped (aggregate image budget ${MAX_TOTAL_BYTES} bytes exceeded)`);
                  continue;
                }
                total += bytes.length;
                blocks.push({ type: "image", data: bytes.toString("base64"), mimeType: mime });
                notes.push(`  ${rel}: ${mime}, ${bytes.length} bytes`);
              } catch (e) {
                notes.push(`  ${p}: ${errMessage(e)}`);
              }
            }

            if (blocks.length === 0) {
              return fail(`view_image: no viewable image(s).\n${notes.join("\n")}`);
            }
            const header = `view_image — ${blocks.length} image(s):\n${notes.join("\n")}`;
            return { content: [{ type: "text", text: header }, ...blocks] };
          } catch (err) {
            return fail(`view_image failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

function extOf(p: string): string {
  const dot = p.lastIndexOf(".");
  return dot === -1 ? "" : p.slice(dot + 1).toLowerCase();
}
