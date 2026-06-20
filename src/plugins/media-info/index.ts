import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { aspectRatio, imageDimensions } from "../../core/image-meta.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { runBinary } from "../../core/run-script.js";

const HEADER_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 15_000;
const RASTER_EXTS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp", "avif", "heic"]);
const AV_EXTS = new Set(["mp4", "mov", "webm", "mkv", "avi", "m4v", "mp3", "wav", "m4a", "aac", "ogg", "flac", "opus"]);

/**
 * Reports facts about media files (dimensions, format, size; for video and audio
 * also duration, fps, codec) without loading the bytes. Raster dimensions come
 * from the file header with no extra dependency. Video and audio details use
 * `ffprobe` when it is on PATH. Optionally maps a duration to a frame count at a
 * given fps.
 */
export function mediaInfoPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "media-info",
    version: "1.0.4",
    tier: "free",
    group: "design",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "media_info",
        title: "Media info",
        description:
          "Report facts about image, video, and audio files (format, dimensions, aspect ratio, byte size, and for A/V via ffprobe if present duration, fps, codec) instead of reading raw bytes or guessing. Pass fps to also get duration as a frame count (ceil(duration*fps)). Use this for asset sizing, aspect, or timing. Read-only.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          paths: z.array(z.string()).min(1).describe("Media file path(s) relative to the workspace root."),
          fps: z.number().positive().optional().describe("If set, also report each A/V duration as ceil(duration*fps) frames."),
        },
        handler: async (args) => {
          try {
            const paths = (args.paths as unknown[]).map(String);
            const fps = args.fps === undefined ? undefined : Number(args.fps);
            const root = ctx.config.root;
            let ffprobeMissing = false;

            const lines: string[] = [];
            for (const p of paths) {
              const ext = extOf(p);
              try {
                if (RASTER_EXTS.has(ext) && ext !== "avif" && ext !== "heic") {
                  const { bytes, size } = await ctx.fs.readHeadBytes(p, HEADER_BYTES);
                  const dim = imageDimensions(bytes);
                  const rel = ctx.paths.relative(ctx.paths.resolve(p));
                  if (dim?.width && dim?.height) {
                    lines.push(`  ${rel}: ${dim.format} ${dim.width}x${dim.height} (${aspectRatio(dim.width, dim.height)}), ${size} bytes`);
                  } else {
                    lines.push(`  ${rel}: ${dim?.format ?? ext}, ${size} bytes (dimensions unavailable)`);
                  }
                } else if (AV_EXTS.has(ext) || ext === "avif" || ext === "heic") {
                  const abs = ctx.paths.resolve(p); // sandbox check
                  const rel = ctx.paths.relative(abs);
                  const probe = await ffprobe(root, abs);
                  if (probe === "missing") {
                    ffprobeMissing = true;
                    lines.push(`  ${rel}: ${ext} (install ffprobe for details)`);
                  } else if (probe === undefined) {
                    lines.push(`  ${rel}: ${ext} (probe failed)`);
                  } else {
                    lines.push(`  ${rel}: ${formatProbe(probe, fps)}`);
                  }
                } else {
                  lines.push(`  ${p}: unsupported media type "${ext}"`);
                }
              } catch (e) {
                lines.push(`  ${p}: ${errMessage(e)}`);
              }
            }
            const note = ffprobeMissing ? "\n(ffprobe not found on PATH — A/V details limited)" : "";
            return ok(`media_info — ${paths.length} file(s):\n${lines.join("\n")}${note}`);
          } catch (err) {
            return fail(`media_info failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

interface Probe {
  durationS?: number;
  width?: number;
  height?: number;
  fps?: number;
  vCodec?: string;
  aCodec?: string;
}

/** Run `ffprobe -of json` on a file. "missing" if ffprobe isn't installed. */
async function ffprobe(cwd: string, abs: string): Promise<Probe | undefined | "missing"> {
  const r = await runBinary(cwd, "ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", abs], PROBE_TIMEOUT_MS);
  if (r.notFound) return "missing";
  if (r.code !== 0 || r.output.trim() === "") return undefined;
  let data: { format?: { duration?: string }; streams?: Array<Record<string, unknown>> };
  try {
    data = JSON.parse(r.output);
  } catch {
    return undefined;
  }
  const out: Probe = {};
  const dur = data.format?.duration;
  if (dur !== undefined && Number.isFinite(Number(dur))) out.durationS = Number(dur);
  for (const s of data.streams ?? []) {
    if (s.codec_type === "video") {
      if (out.width === undefined && typeof s.width === "number") out.width = s.width;
      if (out.height === undefined && typeof s.height === "number") out.height = s.height;
      if (out.vCodec === undefined && typeof s.codec_name === "string") out.vCodec = s.codec_name;
      if (out.fps === undefined && typeof s.r_frame_rate === "string") out.fps = parseRate(s.r_frame_rate);
    } else if (s.codec_type === "audio" && out.aCodec === undefined && typeof s.codec_name === "string") {
      out.aCodec = s.codec_name;
    }
  }
  return out;
}

function formatProbe(p: Probe, fps: number | undefined): string {
  const parts: string[] = [];
  if (p.width && p.height) parts.push(`${p.width}x${p.height} (${aspectRatio(p.width, p.height)})`);
  if (p.durationS !== undefined) {
    let d = `${p.durationS.toFixed(2)}s`;
    if (p.fps) d += ` @${round(p.fps)}fps`;
    if (fps) d += ` = ${Math.ceil(p.durationS * fps)} frames@${fps}`;
    parts.push(d);
  }
  if (p.vCodec) parts.push(`v:${p.vCodec}`);
  if (p.aCodec) parts.push(`a:${p.aCodec}`);
  return parts.length ? parts.join(", ") : "(no stream info)";
}

function parseRate(r: string): number | undefined {
  const m = /^(\d+)\/(\d+)$/.exec(r);
  if (m) {
    const d = Number(m[2]);
    return d > 0 ? Number(m[1]) / d : undefined;
  }
  return Number.isFinite(Number(r)) ? Number(r) : undefined;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function extOf(p: string): string {
  const dot = p.lastIndexOf(".");
  return dot === -1 ? "" : p.slice(dot + 1).toLowerCase();
}
